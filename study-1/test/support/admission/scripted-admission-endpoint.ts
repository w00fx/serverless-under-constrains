// ScriptedAdmissionEndpoint (design §12.2): the HTTP layer under the four real admission clients
// that `createAdmissionClients` builds. The SDK's own serializers, signer and deserializers run;
// only the network is replaced by scripted answers in each service's wire protocol: STS and
// CloudFormation answer awsQuery XML, Lambda answers REST-JSON, DynamoDB answers awsJson1_0.
// Every request is recorded with its operation, Region and method, so a test proves admission
// sent only reads, once each, to `us-east-1`.

import { Readable } from 'node:stream';

import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createAdmissionClients } from '../../../src/admission/aws/admission-aws-readers.ts';
import type { AdmissionClients } from '../../../src/admission/aws/admission-aws-readers.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

export interface RecordedAdmissionCall {
  readonly service: string;
  readonly operation: string;
  readonly region: string;
}

/** A failure the endpoint answers with, in the service's error format. */
export interface ScriptedServiceError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

interface ScriptedAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const REGION_LABEL = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const QUERY_NAMESPACES: Readonly<Record<string, string>> = {
  sts: 'https://sts.amazonaws.com/doc/2011-06-15/',
  cloudformation: 'http://cloudformation.amazonaws.com/doc/2010-05-15/',
};

/**
 * The scripted endpoint and the production clients over it.
 *
 * @example
 * const endpoint = new ScriptedAdmissionEndpoint();
 * endpoint.answerCallerIdentity('012345678901', arn);
 * await createCallerIdentityReader(endpoint.clients.sts).readCallerIdentity();
 */
export class ScriptedAdmissionEndpoint {
  readonly clients: AdmissionClients;
  readonly #answers = new Map<string, ScriptedAnswer>();
  readonly #calls: RecordedAdmissionCall[] = [];

  constructor(settings: Readonly<Record<string, unknown>> = {}) {
    this.clients = createAdmissionClients({
      credentials: { accessKeyId: 'AKIDSCRIPTEDADMISSION', secretAccessKey: 'scripted-admission-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      ...settings,
    });
  }

  /** `sts:GetCallerIdentity` answers this account and ARN. */
  answerCallerIdentity(account: string, arn: string): void {
    this.#answers.set(
      'sts:GetCallerIdentity',
      queryAnswer(
        'sts',
        'GetCallerIdentity',
        `<UserId>AIDAEXAMPLE</UserId><Account>${account}</Account><Arn>${arn}</Arn>`,
      ),
    );
  }

  /** `lambda:GetAccountSettings` answers this `AccountLimit` member. */
  answerAccountSettings(accountLimit: JsonValue): void {
    this.#answers.set('lambda:GetAccountSettings', jsonAnswer({ AccountLimit: accountLimit, AccountUsage: {} }));
  }

  /** `DescribeStacks CDKToolkit` answers one stack in this status, or "does not exist" for `undefined`. */
  answerBootstrapStack(status: string | undefined): void {
    if (status === undefined) {
      this.fail('cloudformation:DescribeStacks', {
        status: 400,
        code: 'ValidationError',
        message: 'Stack with id CDKToolkit does not exist',
      });
      return;
    }
    const stack =
      '<member><StackName>CDKToolkit</StackName><StackId>arn:aws:cloudformation:us-east-1:012345678901:stack/CDKToolkit/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d</StackId>' +
      `<CreationTime>2026-01-01T00:00:00.000Z</CreationTime><StackStatus>${status}</StackStatus></member>`;
    this.#answers.set(
      'cloudformation:DescribeStacks',
      queryAnswer('cloudformation', 'DescribeStacks', `<Stacks>${stack}</Stacks>`),
    );
  }

  /** `DescribeTable` and `DescribeTimeToLive` answer these documents. */
  answerCoordinationTable(table: JsonValue, timeToLive: JsonValue): void {
    this.#answers.set('dynamodb:DescribeTable', jsonAnswer({ Table: table }, 'application/x-amz-json-1.0'));
    this.#answers.set(
      'dynamodb:DescribeTimeToLive',
      jsonAnswer({ TimeToLiveDescription: timeToLive }, 'application/x-amz-json-1.0'),
    );
  }

  /** `service:Operation` answers this error. */
  fail(operation: string, error: ScriptedServiceError): void {
    const service = operation.slice(0, operation.indexOf(':'));
    this.#answers.set(operation, errorAnswer(service, error));
  }

  /** Every request sent so far, in order. */
  calls(): readonly RecordedAdmissionCall[] {
    return [...this.#calls];
  }

  async #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const service = serviceOf(request);
    const region = request.hostname.split('.').find((label) => REGION_LABEL.test(label)) ?? '';
    const operation = operationOf(service, request, await bodyText(request.body));
    this.#calls.push({ service, operation, region });
    const answer = this.#answers.get(`${service}:${operation}`) ?? {
      status: 500,
      contentType: 'text/plain',
      body: `no scripted answer for ${service}:${operation}`,
    };
    return {
      response: {
        statusCode: answer.status,
        headers: { 'content-type': answer.contentType, 'x-amzn-requestid': 'scripted', ...answer.headers },
        body: Readable.from([Buffer.from(answer.body, 'utf8')]),
      },
    };
  }
}

// DynamoDB addresses an ARN-named table at its account endpoint `<account>.ddb.<region>.amazonaws.com`.
function serviceOf(request: HttpRequest): string {
  const labels = request.hostname.split('.');
  return labels.includes('ddb') ? 'dynamodb' : (labels[0] ?? '');
}

function operationOf(service: string, request: HttpRequest, body: string): string {
  if (service === 'sts' || service === 'cloudformation') {
    return new URLSearchParams(body).get('Action') ?? '';
  }
  if (service === 'dynamodb') {
    const target = request.headers['x-amz-target'] ?? '';
    return target.slice(target.indexOf('.') + 1);
  }
  return request.path.endsWith('/account-settings') || request.path.endsWith('/account-settings/')
    ? 'GetAccountSettings'
    : request.path;
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

function queryAnswer(service: string, operation: string, result: string): ScriptedAnswer {
  const namespace = QUERY_NAMESPACES[service] ?? '';
  return {
    status: 200,
    contentType: 'text/xml',
    body:
      `<${operation}Response xmlns="${namespace}"><${operation}Result>${result}</${operation}Result>` +
      `<ResponseMetadata><RequestId>scripted</RequestId></ResponseMetadata></${operation}Response>`,
  };
}

function jsonAnswer(body: JsonValue, contentType = 'application/json'): ScriptedAnswer {
  return { status: 200, contentType, body: JSON.stringify(body) };
}

function errorAnswer(service: string, error: ScriptedServiceError): ScriptedAnswer {
  if (service === 'sts' || service === 'cloudformation') {
    return {
      status: error.status,
      contentType: 'text/xml',
      body:
        `<ErrorResponse xmlns="${QUERY_NAMESPACES[service] ?? ''}"><Error><Type>Sender</Type><Code>${error.code}</Code>` +
        `<Message>${error.message}</Message></Error><RequestId>scripted</RequestId></ErrorResponse>`,
    };
  }
  if (service === 'dynamodb') {
    return {
      status: error.status,
      contentType: 'application/x-amz-json-1.0',
      body: JSON.stringify({ __type: `com.amazonaws.dynamodb.v20120810#${error.code}`, message: error.message }),
    };
  }
  return {
    status: error.status,
    contentType: 'application/json',
    body: JSON.stringify({ message: error.message }),
    headers: { 'x-amzn-errortype': error.code },
  };
}

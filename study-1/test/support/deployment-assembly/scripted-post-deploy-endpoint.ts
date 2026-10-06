// ScriptedPostDeployEndpoint (design §12.2): the HTTP layer under the four real clients that
// `createPostDeployClients` builds. The SDK's own serializers, signer and deserializers run; only
// the network is replaced by answers from a DeployedAccount in each service's wire protocol:
// CloudFormation answers awsQuery XML, Lambda answers REST-JSON (errors in `x-amzn-errortype`), SQS
// answers AWS JSON 1.0 (query-compatible) and DynamoDB answers AWS JSON 1.0. Every request is
// recorded with its service, operation, Region and parameters, so a test proves the reader sent
// one read per call to `us-east-1` and never retried.

import { Readable } from 'node:stream';

import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createPostDeployClients } from '../../../src/deployment-assembly/aws/post-deploy-readers.ts';
import type { PostDeployClients } from '../../../src/deployment-assembly/aws/post-deploy-readers.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { DeployedAccount } from './deployed-account.ts';
import { MISSING_RESOURCE_FAILURES, pageToken } from './fake-post-deploy-reader.ts';

export interface RecordedPostDeployCall {
  readonly service: string;
  readonly operation: string;
  readonly region: string;
  /** The identifying request parameters, for example `{ StackName, NextToken }`. */
  readonly params: Readonly<Record<string, string>>;
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

interface ParsedRequest {
  readonly service: string;
  readonly operation: string;
  readonly params: Readonly<Record<string, string>>;
}

const REGION_LABEL = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const CLOUDFORMATION_NAMESPACE = 'http://cloudformation.amazonaws.com/doc/2010-05-15/';
const AMZ_JSON = 'application/x-amz-json-1.0';
const NO_PROVISIONED_CONCURRENCY: ScriptedServiceError = {
  status: 404,
  code: 'ProvisionedConcurrencyConfigNotFoundException',
  message: 'No Provisioned Concurrency Config found for this function',
};
const LAMBDA_ROUTES: readonly { readonly pattern: RegExp; readonly operation: string; readonly param: string }[] = [
  {
    pattern: /^\/2015-03-31\/functions\/([^/]+)\/configuration\/?$/,
    operation: 'GetFunctionConfiguration',
    param: 'FunctionName',
  },
  { pattern: /^\/2015-03-31\/event-source-mappings\/([^/]+)\/?$/, operation: 'GetEventSourceMapping', param: 'UUID' },
  {
    pattern: /^\/2019-09-30\/functions\/([^/]+)\/provisioned-concurrency\/?$/,
    operation: 'GetProvisionedConcurrencyConfig',
    param: 'FunctionName',
  },
];

/**
 * The scripted endpoint and the production clients over it.
 *
 * @example
 * const endpoint = new ScriptedPostDeployEndpoint(deployedAccount(template, stack, stackId, tags));
 * await createPostDeployReader(endpoint.clients).describeStack(stack);
 */
export class ScriptedPostDeployEndpoint {
  readonly clients: PostDeployClients;
  readonly #account: DeployedAccount;
  readonly #failures = new Map<string, ScriptedServiceError>();
  readonly #calls: RecordedPostDeployCall[] = [];

  constructor(account: DeployedAccount, settings: Readonly<Record<string, unknown>> = {}) {
    this.#account = account;
    this.clients = createPostDeployClients({
      credentials: { accessKeyId: 'AKIDSCRIPTEDPOSTDEPLOY', secretAccessKey: 'scripted-post-deploy-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      ...settings,
    });
  }

  /** Every later `service:Operation` request answers this error. */
  fail(operation: string, error: ScriptedServiceError): void {
    this.#failures.set(operation, error);
  }

  /** Every request sent so far, in order. */
  calls(): readonly RecordedPostDeployCall[] {
    return [...this.#calls];
  }

  async #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const parsed = parseRequest(request, await bodyText(request.body));
    const region = request.hostname.split('.').find((label) => REGION_LABEL.test(label)) ?? '';
    this.#calls.push({ ...parsed, region });
    const failure = this.#failures.get(`${parsed.service}:${parsed.operation}`);
    const answer = failure === undefined ? this.#answer(parsed) : errorAnswer(parsed.service, failure);
    return {
      response: {
        statusCode: answer.status,
        headers: { 'content-type': answer.contentType, 'x-amzn-requestid': 'scripted', ...answer.headers },
        body: Readable.from([Buffer.from(answer.body, 'utf8')]),
      },
    };
  }

  #answer(request: ParsedRequest): ScriptedAnswer {
    const { params } = request;
    const qualified = `${params['FunctionName'] ?? ''}:${params['Qualifier'] ?? ''}`;
    const uuid = params['UUID'] ?? '';
    switch (`${request.service}:${request.operation}`) {
      case 'cloudformation:DescribeStacks':
        return this.#describeStacks(params['StackName'] ?? '');
      case 'cloudformation:ListStackResources':
        return this.#listStackResources(params['StackName'] ?? '', params['NextToken']);
      case 'lambda:GetFunctionConfiguration':
        return this.#lambda(
          this.#account.functions,
          qualified,
          notFound(MISSING_RESOURCE_FAILURES.readFunctionConfiguration(qualified)),
        );
      case 'lambda:GetEventSourceMapping':
        return this.#lambda(
          this.#account.mappings,
          uuid,
          notFound(MISSING_RESOURCE_FAILURES.readEventSourceMapping(uuid)),
        );
      case 'lambda:GetProvisionedConcurrencyConfig':
        return this.#lambda(this.#account.concurrency, qualified, NO_PROVISIONED_CONCURRENCY);
      case 'sqs:GetQueueAttributes':
        return this.#queue(params['QueueUrl'] ?? '');
      case 'dynamodb:DescribeTable':
        return this.#table(params['TableName'] ?? '');
      default:
        return {
          status: 500,
          contentType: 'text/plain',
          body: `no scripted answer for ${request.service}:${request.operation}`,
        };
    }
  }

  #describeStacks(stackName: string): ScriptedAnswer {
    const stack = this.#account.stack;
    if (stack === undefined || (stackName !== this.#account.stack_name && stackName !== stack['StackId'])) {
      return errorAnswer('cloudformation', {
        status: 400,
        code: 'ValidationError',
        message: `Stack with id ${stackName} does not exist`,
      });
    }
    const tags = (stack['Tags'] as readonly Readonly<Record<string, JsonValue>>[] | undefined) ?? [];
    const member =
      `<member><StackName>${xml(stack['StackName'])}</StackName><StackId>${xml(stack['StackId'])}</StackId>` +
      `<CreationTime>2026-10-05T12:00:00.000Z</CreationTime><StackStatus>${xml(stack['StackStatus'])}</StackStatus>` +
      `<Tags>${tags.map((tag) => `<member><Key>${xml(tag['Key'])}</Key><Value>${xml(tag['Value'])}</Value></member>`).join('')}</Tags></member>`;
    return queryAnswer('DescribeStacks', `<Stacks>${member}</Stacks>`);
  }

  #listStackResources(stack: string, nextToken: string | undefined): ScriptedAnswer {
    const described = this.#account.stack;
    if (described === undefined || (stack !== this.#account.stack_name && stack !== described['StackId'])) {
      const missing = MISSING_RESOURCE_FAILURES.listStackResources(stack);
      return errorAnswer('cloudformation', { status: 400, code: missing.code, message: missing.detail });
    }
    const page = nextToken === undefined ? 0 : Number(nextToken.slice('page-'.length));
    const size = this.#account.page_size;
    const members = this.#account.resources
      .slice(page * size, (page + 1) * size)
      .map(
        (summary) =>
          `<member><LogicalResourceId>${xml(summary['LogicalResourceId'])}</LogicalResourceId>` +
          `<PhysicalResourceId>${xml(summary['PhysicalResourceId'])}</PhysicalResourceId>` +
          `<ResourceType>${xml(summary['ResourceType'])}</ResourceType>` +
          `<LastUpdatedTimestamp>2026-10-05T12:00:00.000Z</LastUpdatedTimestamp>` +
          `<ResourceStatus>${xml(summary['ResourceStatus'])}</ResourceStatus></member>`,
      );
    const more = (page + 1) * size < this.#account.resources.length;
    const token = more ? `<NextToken>${pageToken(page + 1)}</NextToken>` : '';
    return queryAnswer(
      'ListStackResources',
      `<StackResourceSummaries>${members.join('')}</StackResourceSummaries>${token}`,
    );
  }

  #lambda(outputs: Readonly<Record<string, JsonValue>>, key: string, missing: ScriptedServiceError): ScriptedAnswer {
    const output = Object.hasOwn(outputs, key) ? outputs[key] : undefined;
    if (output === undefined) {
      return errorAnswer('lambda', missing);
    }
    return { status: 200, contentType: 'application/json', body: JSON.stringify(output) };
  }

  #queue(queueUrl: string): ScriptedAnswer {
    const attributes = this.#account.queues[queueUrl];
    if (attributes === undefined) {
      const missing = MISSING_RESOURCE_FAILURES.readQueueAttributes();
      return errorAnswer('sqs', { status: 400, code: missing.code, message: missing.detail });
    }
    return { status: 200, contentType: AMZ_JSON, body: JSON.stringify({ Attributes: attributes }) };
  }

  #table(tableName: string): ScriptedAnswer {
    const table = this.#account.tables[tableName];
    if (table === undefined) {
      const missing = MISSING_RESOURCE_FAILURES.readTable(tableName);
      return errorAnswer('dynamodb', { status: 400, code: missing.code, message: missing.detail });
    }
    return { status: 200, contentType: AMZ_JSON, body: JSON.stringify({ Table: table }) };
  }
}

function notFound(failure: { readonly code: string; readonly detail: string }): ScriptedServiceError {
  return { status: 404, code: failure.code, message: failure.detail };
}

function parseRequest(request: HttpRequest, body: string): ParsedRequest {
  const labels = request.hostname.split('.');
  const service = labels.includes('ddb') ? 'dynamodb' : (labels[0] ?? '');
  if (service === 'cloudformation') {
    const form = new URLSearchParams(body);
    const params = Object.fromEntries([...form].filter(([name]) => name === 'StackName' || name === 'NextToken'));
    return { service, operation: form.get('Action') ?? '', params };
  }
  if (service === 'sqs' || service === 'dynamodb') {
    const target = request.headers['x-amz-target'] ?? '';
    const parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, JsonValue>;
    const params = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    return { service, operation: target.slice(target.indexOf('.') + 1), params };
  }
  return lambdaRequest(service, request);
}

function lambdaRequest(service: string, request: HttpRequest): ParsedRequest {
  const qualifier = request.query?.['Qualifier'];
  const route = LAMBDA_ROUTES.find((candidate) => candidate.pattern.test(request.path));
  const value = route === undefined ? undefined : route.pattern.exec(request.path)?.[1];
  const params: Record<string, string> = {};
  if (route !== undefined && value !== undefined) {
    params[route.param] = decodeURIComponent(value);
  }
  if (typeof qualifier === 'string') {
    params['Qualifier'] = qualifier;
  }
  return { service, operation: route?.operation ?? request.path, params };
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

function xml(value: JsonValue | undefined): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function queryAnswer(operation: string, result: string): ScriptedAnswer {
  return {
    status: 200,
    contentType: 'text/xml',
    body:
      `<${operation}Response xmlns="${CLOUDFORMATION_NAMESPACE}"><${operation}Result>${result}</${operation}Result>` +
      `<ResponseMetadata><RequestId>scripted</RequestId></ResponseMetadata></${operation}Response>`,
  };
}

function errorAnswer(service: string, error: ScriptedServiceError): ScriptedAnswer {
  if (service === 'cloudformation') {
    return {
      status: error.status,
      contentType: 'text/xml',
      body:
        `<ErrorResponse xmlns="${CLOUDFORMATION_NAMESPACE}"><Error><Type>Sender</Type><Code>${xml(error.code)}</Code>` +
        `<Message>${xml(error.message)}</Message></Error><RequestId>scripted</RequestId></ErrorResponse>`,
    };
  }
  if (service === 'sqs') {
    return {
      status: error.status,
      contentType: AMZ_JSON,
      body: JSON.stringify({ __type: `com.amazonaws.sqs#${error.code}`, message: error.message }),
    };
  }
  if (service === 'dynamodb') {
    return {
      status: error.status,
      contentType: AMZ_JSON,
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

// The resource types cleanup names (design §9.2, §9.14). CloudFormation types name what a stack
// creates. Cleanup also acts on things CloudFormation never records: a running durable
// execution (stopped before stack deletion, RK-10), a captured DLQ message (BR-RUA-048 steps
// 7-8) and a treatment item (step 5 safety release). They get service-qualified pseudo types
// in the same `Service::Resource` spelling, so every cleanup journal event and leak names a
// resource the same way. No CloudFormation type uses these names.

export const STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
export const FUNCTION_RESOURCE_TYPE = 'AWS::Lambda::Function';
export const FUNCTION_VERSION_RESOURCE_TYPE = 'AWS::Lambda::Version';
export const FUNCTION_ALIAS_RESOURCE_TYPE = 'AWS::Lambda::Alias';
export const EVENT_SOURCE_MAPPING_RESOURCE_TYPE = 'AWS::Lambda::EventSourceMapping';
export const QUEUE_RESOURCE_TYPE = 'AWS::SQS::Queue';
export const TABLE_RESOURCE_TYPE = 'AWS::DynamoDB::Table';
export const LOG_GROUP_RESOURCE_TYPE = 'AWS::Logs::LogGroup';
export const ROLE_RESOURCE_TYPE = 'AWS::IAM::Role';

/** Pseudo type: one durable execution of a run-owned function. */
export const DURABLE_EXECUTION_RESOURCE_TYPE = 'AWS::Lambda::DurableExecution';
/** Pseudo type: one message in a run-owned dead-letter queue, named by its message id. */
export const DLQ_MESSAGE_RESOURCE_TYPE = 'AWS::SQS::Message';
/** Pseudo type: the treatment item of one control-table partition, named by its partition key. */
export const TREATMENT_ITEM_RESOURCE_TYPE = 'AWS::DynamoDB::TreatmentItem';
/**
 * Pseudo type: the stream of a run-owned table, as the tag index lists it with the table's tags.
 * DynamoDB keeps a deleted table's stream readable (DISABLED) for up to 24 hours and offers no
 * way to delete it, so the stream is present only while its table exists (A-16, decision 85).
 */
export const TABLE_STREAM_RESOURCE_TYPE = 'AWS::DynamoDB::TableStream';

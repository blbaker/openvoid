#!/usr/bin/env node
// Create the S3 bucket and/or DynamoDB table an OpenVoid app is configured to use, if missing.
// Meant for local and test setups (DynamoDB Local, SeaweedFS, MinIO). On AWS, create them with
// the commands in recipes/aws-lambda-web-functions/README.md instead.
//
//   OPENVOID_KV=dynamodb:my-table OPENVOID_STORAGE=s3://my-bucket node scripts/ensure-infra.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'node', 'package.json'));

const kv = process.env.OPENVOID_KV ?? '';
const storage = process.env.OPENVOID_STORAGE ?? '';

if (kv.startsWith('dynamodb:')) {
  const { DynamoDBClient, CreateTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
  const table = kv.slice('dynamodb:'.length).split('?')[0];
  const client = new DynamoDBClient({});
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: table });
    await client.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { Enabled: true, AttributeName: 'exp' } }));
    console.log(`created DynamoDB table ${table}`);
  } catch (error) {
    if (error.name !== 'ResourceInUseException') throw error;
    console.log(`DynamoDB table ${table} exists`);
  }
}

if (storage.startsWith('s3://')) {
  const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
  const bucket = new URL(storage).hostname;
  const client = new S3Client({ forcePathStyle: process.env.OPENVOID_S3_FORCE_PATH_STYLE === '1' });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket ${bucket}`);
  } catch (error) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) throw error;
    console.log(`bucket ${bucket} exists`);
  }
}

# Recipe: AWS Lambda Web Functions

[Lambda Web Functions](https://aws.amazon.com/lambda/lambda-web-functions/) launched on
October 12, 2026. They run an ordinary Node.js HTTP server: Lambda starts `index.js`, tells it
where to listen through `AWS_LAMBDA_HTTP_ENDPOINT`, sends it many requests at once, and bills
active CPU time. That is the shape of an OpenVoid server, so no adapter is needed.

| Void API | Backend on AWS | OpenVoid setting |
| --- | --- | --- |
| `void/db` | PostgreSQL (RDS, Aurora, or any reachable Postgres) | `DATABASE_URL` |
| `void/kv` | DynamoDB table | `OPENVOID_KV=dynamodb:<table>` |
| `void/storage` | S3 bucket | `OPENVOID_STORAGE=s3://<bucket>` |

SQLite and local files are a poor fit here. The code directory is read-only and each execution
environment has its own short-lived `/tmp`, so OpenVoid prints a warning at startup if it finds
local backends on Lambda.

## Status

Tested against the Web Functions contract, not yet against a real AWS account. `scripts/e2e.sh
lambda` packages the `notes-pg` example with `package.sh` and runs it in a `node:24-slim`
container with a read-only code directory, a writable `/tmp` only, `AWS_LAMBDA_HTTP_ENDPOINT`
and the 10 second start window, against DynamoDB Local, an S3-compatible server and
PostgreSQL. CI runs it on arm64. The AWS commands below follow the AWS documentation as it read
on October 17, 2026. If one of them has changed, please open an issue.

## Files

- `package.sh` turns a built app into a deployment folder and zip with `index.js` at the root
- `iam-policy.json` grants the app its DynamoDB table and S3 bucket
- `trust-policy.json` lets Lambda assume the execution role
- `revision-config.example.json` shows a revision with OpenVoid's environment variables

## Steps

The examples use `us-east-1` and an app called `my-app`. Web Functions are available in
us-east-1, us-east-2, us-west-2, eu-west-1 and ap-northeast-1 at launch.

### 1. Use PostgreSQL in the app

```ts
// void.config.ts
export default defineConfig({ target: 'node', database: 'pg' });
```

Schema files import from `void/schema-pg`, and `db/migrations` holds PostgreSQL SQL.

### 2. Create the data services (once)

```sh
aws dynamodb create-table --table-name my-app-kv \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --table-name my-app-kv \
  --time-to-live-specification Enabled=true,AttributeName=exp

aws s3 mb s3://my-app-files
```

For PostgreSQL, create an RDS or Aurora PostgreSQL database, or use any Postgres the function
can reach. A database inside a VPC needs the Web Function's
[VPC networking](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html)
set up. Every execution environment opens its own pool (`OPENVOID_PG_POOL_MAX`, default 10),
so put RDS Proxy in front if you expect many environments.

### 3. Build and package

```sh
npm run build
path/to/openvoid/recipes/aws-lambda-web-functions/package.sh . .lambda
```

This writes `.lambda/` and `.lambda.zip`. The bundle is plain JavaScript, so packaging on an
x86_64 machine is fine for Lambda's arm64.

### 4. Run migrations

Apply migrations from your machine or CI before the new code goes live, not inside Lambda.
Many environments can start at once and each one has only 10 seconds to start listening.

```sh
DATABASE_URL='postgres://...' node .lambda/index.js migrate
```

### 5. Create the execution role (once)

Replace `REGION`, `ACCOUNT_ID`, `TABLE_NAME` and `BUCKET_NAME` in `iam-policy.json` first.

```sh
aws iam create-role --role-name my-app-openvoid --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name my-app-openvoid \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name my-app-openvoid --policy-name openvoid-data \
  --policy-document file://iam-policy.json
```

### 6. Create the Web Function

Upload the zip to a versioned bucket you use for code, then create the function with its
environment variables. Copy `revision-config.example.json` to `revision-config.json` and fill
in the values; it is the `--revision-config` argument as-is.

```sh
aws s3 cp .lambda.zip s3://my-code-bucket/my-app/app.zip

aws lambda-web create-web-function --function-name my-app \
  --revision-config file://revision-config.json \
  --endpoint-config '{"endpointName":"prod","endpointType":"HomeRegion","authType":"ApplicationManaged","autoDeploymentMode":"LatestRevision"}'
```

To ship a new build, upload it again and create a revision. This command takes the
`buildConfig` and `serviceConfig` objects from `revision-config.json` as two separate files.
Revisions are complete snapshots, so include every environment variable each time.

```sh
aws lambda-web create-web-function-revision --function-name my-app \
  --build-config file://build-config.json --service-config file://service-config.json
```

`aws lambda-web deploy --name my-app --code ./.lambda` is the one-command path from the AWS
docs. Those docs don't show a way to pass environment variables to it, so use it only for an
app that runs on its defaults.

## Things to know

- AWS recommends Secrets Manager or Parameter Store for credentials rather than environment
  variables. OpenVoid reads `DATABASE_URL` from the environment today; reading it from Secrets
  Manager is planned.
- The DynamoDB table and S3 bucket are regional. If you deploy to several regions with
  `--regions`, every region reaches the same table, bucket and database unless you set up
  Global Tables and replication yourself.
- `AWS_REGION` and the AWS credentials are reserved variables on Web Functions. Lambda sets
  them, and the AWS SDK inside OpenVoid picks them up.
- Static assets of a pages app are served by the function. Put CloudFront in front if you want
  them cached at the edge.

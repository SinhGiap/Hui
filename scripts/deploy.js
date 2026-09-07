'use strict';
// Everything bootstrap.js does not create: Lambda x2, API Gateway,
// Beanstalk, the EventBridge schedule and the Athena result location.
//
// Learner Lab sessions expire every ~4 hours and accounts get reset, so every
// step here is idempotent - re-running is the recovery procedure, not a mistake.
// Discovered values (API_BASE, CDN_DOMAIN) are written back into .env so the
// next phase and the local scripts pick them up without hand-editing.
//
// Run: npm run deploy            (all phases)
//      npm run deploy -- lambda  (one phase: lambda|api|web|cron|athena)
const fs = require('fs');
const { build: buildZip } = require('./zip');
const { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, AddPermissionCommand, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const { APIGatewayClient, GetRestApisCommand, CreateRestApiCommand, GetResourcesCommand, CreateResourceCommand, PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand } = require('@aws-sdk/client-api-gateway');
const { S3Client, PutObjectCommand, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
const { ElasticBeanstalkClient, CreateApplicationCommand, CreateApplicationVersionCommand, DescribeApplicationVersionsCommand, CreateEnvironmentCommand, DescribeEnvironmentsCommand, UpdateEnvironmentCommand, ListAvailableSolutionStacksCommand } = require('@aws-sdk/client-elastic-beanstalk');
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand } = require('@aws-sdk/client-eventbridge');
const { AthenaClient, UpdateWorkGroupCommand } = require('@aws-sdk/client-athena');

const region = process.env.AWS_REGION || 'us-east-1';
const cfg = { region };
const lambda = new LambdaClient(cfg);
const apigw = new APIGatewayClient(cfg);
const s3 = new S3Client(cfg);
const eb = new ElasticBeanstalkClient(cfg);
const events = new EventBridgeClient(cfg);
const athena = new AthenaClient(cfg);

const APP = 'hui';
const API_FN = `${APP}-api`;
const NIGHTLY_FN = `${APP}-nightly`;
const RULE = `${APP}-nightly-export`;
const ANALYTICS = process.env.ANALYTICS_BUCKET;
const EVIDENCE = process.env.EVIDENCE_BUCKET;
const ROLE = process.env.LAB_ROLE_ARN;
const ACCOUNT = ROLE && ROLE.split(':')[4];

// Only these reach Lambda. An explicit allow-list, not a copy of process.env,
// because .env also holds the pasted lab credentials and AWS_REGION is reserved.
const LAMBDA_ENV = ['TABLE_NAME', 'EVIDENCE_BUCKET', 'ANALYTICS_BUCKET', 'CDN_DOMAIN',
  'GLUE_DATABASE', 'GLUE_CRAWLER', 'ATHENA_WORKGROUP', 'JWT_SECRET', 'ALLOWED_ORIGIN', 'DEMO_MODE'];

const log = (...a) => console.log(' ', ...a);
const exists = (e) => ['ResourceConflictException', 'ResourceAlreadyExistsException', 'EntityAlreadyExists',
  'InvalidParameterValue',
  'TooManyApplicationVersions'].includes(e.name);

// Writes a value back into .env so later phases and `npm run dev` see it.
function setEnv(key, value) {
  let t = fs.readFileSync('.env', 'utf8');
  t = new RegExp(`^${key}=`, 'm').test(t)
    ? t.replace(new RegExp(`^${key}=.*`, 'm'), `${key}=${value}`)
    : `${t.replace(/\s*$/, '')}\n${key}=${value}`;
  fs.writeFileSync('.env', t);
  process.env[key] = value;
}

const envVars = () => Object.fromEntries(LAMBDA_ENV.map((k) => [k, process.env[k] || '']));

function zip(which) {
  log(`packaging ${which} ...`);
  const { file, mb } = buildZip(which);
  log(`${file} ${mb.toFixed(1)} MB`);
  return fs.readFileSync(file);
}

// ---------------------------------------------------------------- lambda ----
async function upsertFn(FunctionName, Handler, Timeout, ZipFile) {
  const common = { FunctionName, Handler, Timeout, MemorySize: 512, Role: ROLE, Runtime: 'nodejs20.x', Environment: { Variables: envVars() } };
  try {
    await lambda.send(new CreateFunctionCommand({ ...common, Code: { ZipFile }, Publish: true }));
    log(`created  ${FunctionName}`);
  } catch (e) {
    if (!exists(e)) throw e;
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName, ZipFile }));
    // Code and config updates cannot overlap; the function is briefly "Pending".
    for (let i = 0; i < 30; i++) {
      const { Configuration } = await lambda.send(new GetFunctionCommand({ FunctionName }));
      if (Configuration.LastUpdateStatus !== 'InProgress') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await lambda.send(new UpdateFunctionConfigurationCommand(common));
    log(`updated  ${FunctionName}`);
  }
  return `arn:aws:lambda:${region}:${ACCOUNT}:function:${FunctionName}`;
}

async function phaseLambda() {
  console.log('\nLambda');
  const bundle = zip('api');
  await upsertFn(API_FN, 'api/index.handler', 30, bundle);      // 30s: Athena polling
  await upsertFn(NIGHTLY_FN, 'api/index.nightlyExport', 60, bundle);
}

// ------------------------------------------------------------ api gateway ----
async function phaseApi() {
  console.log('\nAPI Gateway');
  const fnArn = `arn:aws:lambda:${region}:${ACCOUNT}:function:${API_FN}`;
  const { items = [] } = await apigw.send(new GetRestApisCommand({ limit: 500 }));
  let api = items.find((a) => a.name === APP);
  if (api) {
    log(`exists   rest api ${api.id}`);
  } else {
    api = await apigw.send(new CreateRestApiCommand({ name: APP, description: 'Hui ROSCA API' }));
    log(`created  rest api ${api.id}`);
  }

  const { items: resources } = await apigw.send(new GetResourcesCommand({ restApiId: api.id }));
  const root = resources.find((r) => r.path === '/');
  let proxy = resources.find((r) => r.path === '/{proxy+}');
  if (!proxy) {
    proxy = await apigw.send(new CreateResourceCommand({ restApiId: api.id, parentId: root.id, pathPart: '{proxy+}' }));
    log('created  /{proxy+}');
  }

  // ANY + AWS_PROXY only. The handler already answers OPTIONS and sets the CORS
  // headers itself, so the console's "Enable CORS" MOCK integration is dead weight.
  for (const resourceId of [proxy.id]) {
    try {
      await apigw.send(new PutMethodCommand({ restApiId: api.id, resourceId, httpMethod: 'ANY', authorizationType: 'NONE' }));
    } catch (e) { if (!exists(e)) throw e; }
    await apigw.send(new PutIntegrationCommand({
      restApiId: api.id, resourceId, httpMethod: 'ANY',
      type: 'AWS_PROXY', integrationHttpMethod: 'POST',
      uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`,
    }));
  }
  log('wired    ANY -> lambda proxy');

  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: API_FN, StatementId: 'apigw-invoke', Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com', SourceArn: `arn:aws:execute-api:${region}:${ACCOUNT}:${api.id}/*/*/*`,
    }));
  } catch (e) { if (!exists(e)) throw e; }

  await apigw.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: 'prod' }));
  const base = `https://${api.id}.execute-api.${region}.amazonaws.com/prod`;
  setEnv('API_BASE', base);
  log(`deployed ${base}`);
}


// --------------------------------------------------------------- beanstalk ----
async function phaseWeb() {
  console.log('\nElastic Beanstalk');
  const bundle = zip('web');
  const key = `deploy/dist-web-${Date.now()}.zip`;
  await s3.send(new PutObjectCommand({ Bucket: ANALYTICS, Key: key, Body: bundle }));

  try { await eb.send(new CreateApplicationCommand({ ApplicationName: APP })); } catch (e) { if (!exists(e)) throw e; }

  const { SolutionStacks } = await eb.send(new ListAvailableSolutionStacksCommand({}));
  // Learner Lab does not offer Node.js 20 here, so take the newest LTS on offer.
  // Nothing in web/ is version-pinned - Procfile runs `node web/server.js` and the
  // --env-file flag only appears in the local npm scripts.
  const node = SolutionStacks.filter((s) => /Amazon Linux 2023/.test(s) && /Node\.js \d+/.test(s));
  const stack = node.find((s) => /Node\.js 22/.test(s)) || node[0];
  if (!stack) throw new Error(`no Amazon Linux 2023 Node.js stack available; offered: ${SolutionStacks.filter((s) => /Node/.test(s)).join(', ')}`);
  log(`stack    ${stack}`);

  const VersionLabel = `v${Date.now()}`;
  await eb.send(new CreateApplicationVersionCommand({
    ApplicationName: APP, VersionLabel, SourceBundle: { S3Bucket: ANALYTICS, S3Key: key }, Process: true,
  }));
  // Process:true validates the bundle asynchronously, and deploying before that
  // finishes is rejected outright.
  for (let i = 0; i < 40; i++) {
    const { ApplicationVersions } = await eb.send(new DescribeApplicationVersionsCommand({ ApplicationName: APP, VersionLabels: [VersionLabel] }));
    const status = ApplicationVersions[0]?.Status;
    if (status === 'PROCESSED' || status === 'UNPROCESSED') break;
    if (status === 'FAILED') throw new Error(`bundle ${VersionLabel} failed validation`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  // SingleInstance: no load balancer to provision. Flip to LoadBalanced for an ASG.
  const OptionSettings = [
    { Namespace: 'aws:autoscaling:launchconfiguration', OptionName: 'IamInstanceProfile', Value: 'LabInstanceProfile' },
    { Namespace: 'aws:elasticbeanstalk:environment', OptionName: 'ServiceRole', Value: ROLE },
    { Namespace: 'aws:elasticbeanstalk:environment', OptionName: 'EnvironmentType', Value: 'SingleInstance' },
    { Namespace: 'aws:elasticbeanstalk:application:environment', OptionName: 'API_BASE', Value: process.env.API_BASE },
    { Namespace: 'aws:elasticbeanstalk:application:environment', OptionName: 'CDN_DOMAIN', Value: process.env.CDN_DOMAIN || '' },
  ];

  const EnvironmentName = `${APP}-env`;
  const { Environments } = await eb.send(new DescribeEnvironmentsCommand({ ApplicationName: APP, EnvironmentNames: [EnvironmentName], IncludeDeleted: false }));
  const live = Environments.find((e) => e.Status !== 'Terminated');
  if (live) {
    await eb.send(new UpdateEnvironmentCommand({ ApplicationName: APP, EnvironmentName, VersionLabel, OptionSettings }));
    log(`updated  ${EnvironmentName} -> http://${live.CNAME}`);
  } else {
    const r = await eb.send(new CreateEnvironmentCommand({ ApplicationName: APP, EnvironmentName, SolutionStackName: stack, VersionLabel, OptionSettings }));
    log(`created  ${EnvironmentName} (~5 min to go green), id ${r.EnvironmentId}`);
  }
}

// ------------------------------------------------------- eventbridge, athena ----
async function phaseCron() {
  console.log('\nEventBridge');
  const arn = `arn:aws:lambda:${region}:${ACCOUNT}:function:${NIGHTLY_FN}`;
  const { RuleArn } = await events.send(new PutRuleCommand({ Name: RULE, ScheduleExpression: 'cron(0 15 * * ? *)', State: 'ENABLED' }));
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: NIGHTLY_FN, StatementId: 'events-invoke', Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com', SourceArn: RuleArn,
    }));
  } catch (e) { if (!exists(e)) throw e; }
  await events.send(new PutTargetsCommand({ Rule: RULE, Targets: [{ Id: '1', Arn: arn }] }));
  log(`rule     ${RULE} -> ${NIGHTLY_FN} (daily 15:00 UTC)`);
}

async function phaseAthena() {
  console.log('\nAthena');
  const OutputLocation = `s3://${ANALYTICS}/athena-results/`;
  await athena.send(new UpdateWorkGroupCommand({
    WorkGroup: process.env.ATHENA_WORKGROUP || 'primary',
    ConfigurationUpdates: { ResultConfigurationUpdates: { OutputLocation } },
  }));
  log(`results  ${OutputLocation}`);
}

const PHASES = { lambda: phaseLambda, api: phaseApi, web: phaseWeb, cron: phaseCron, athena: phaseAthena };

async function main() {
  if (!ROLE) { console.error('Set LAB_ROLE_ARN in .env (npm run bootstrap prints how).'); process.exit(1); }
  if (!ANALYTICS || !EVIDENCE) { console.error('Set EVIDENCE_BUCKET and ANALYTICS_BUCKET in .env.'); process.exit(1); }
  const only = process.argv.slice(2).filter((a) => PHASES[a]);
  const run = only.length ? only : Object.keys(PHASES);
  console.log(`account ${ACCOUNT}, region ${region}, phases: ${run.join(' ')}`);
  for (const name of run) {
    try {
      await PHASES[name]();
    } catch (e) {
      console.log(`  FAILED   ${name}: ${e.name} - ${e.message.split(String.fromCharCode(10))[0]}`);
    }
  }
  console.log(`\nAPI_BASE=${process.env.API_BASE}\nCDN_DOMAIN=${process.env.CDN_DOMAIN || '(none)'}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

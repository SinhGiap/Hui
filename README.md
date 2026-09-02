# Hui — digital rotating savings and credit association

A **ROSCA** (*hui* in Vietnamese, *tontine*, *chit fund*, *arisan*) is a savings circle: a group of
people each contribute a fixed amount every cycle, and the whole pot goes to one member per cycle
until everyone has been paid exactly once. It has funded shops, weddings and school fees across
South East Asia for generations, entirely on interpersonal trust and with no bank involved.

This app is the digital version. Members create or join a circle, log their contribution each cycle,
and every member accumulates a **reliability score** from their on-time payment history — so a future
circle can see who they are admitting before any money moves. That score is the piece a paper ledger
cannot give you: portable credit history for people outside the formal banking system.

---

## Architecture

```
                   browser
                      |
        (pages)       |       (all data: fetch + JWT)
                      v
    ┌─────────────────────────┐        ┌──────────────────────────┐
    │  Elastic Beanstalk      │        │  API Gateway  {proxy+}   │
    │  Express + EJS shell    │───────>│  REST, CORS, stage /prod │
    └─────────────────────────┘        └────────────┬─────────────┘
                                                    v
                                       ┌──────────────────────────┐
                                       │  Lambda  api/index.js    │
                                       │  auth, groups, ledger,   │
                                       │  scoring, presign, report│
                                       └───┬──────┬──────┬────────┘
                        ┌──────────────────┘      │      └──────────────┐
                        v                         v                     v
                ┌───────────────┐        ┌────────────────┐    ┌─────────────────┐
                │  DynamoDB     │        │  S3 evidence   │    │  3rd-party APIs │
                │  single table │        │  presigned PUT │    │  Nager.Date     │
                └───────┬───────┘        └───────┬────────┘    │  ExchangeRate   │
                        │                        v             └─────────────────┘
                        │                ┌────────────────┐
                        │                │  CloudFront    │  serves evidence images
                        │                └────────────────┘
                        │
   EventBridge (nightly cron)
                        v
                ┌───────────────┐    ┌──────────┐    ┌──────────────────────────┐
                │ Lambda        │───>│ S3       │───>│ Glue crawler -> catalog  │
                │ nightlyExport │    │ analytics│    └────────────┬─────────────┘
                └───────────────┘    │ ledger/  │                 v
                                     │ dt=...   │        ┌──────────────────┐
                                     └──────────┘        │ Athena           │
                                                         │ on-time reporting│
                                                         └──────────────────┘
```

### Why each service

| Service | Role in this app |
|---|---|
| **Elastic Beanstalk** | Hosts the Express/EJS interface tier. Managed capacity and health so the UI scales without the app owning any server config. |
| **API Gateway** | The single public entry to the API. Terminates TLS, applies CORS and throttling, routes `{proxy+}` to one Lambda. |
| **Lambda** | All business logic: auth, circle lifecycle, ledger writes, reliability scoring, presigning, reporting. Also the nightly export. Cost is zero between cycles, which suits traffic that spikes on due dates. |
| **DynamoDB** | Users, circles, memberships and the contribution ledger. Every access pattern is a key lookup, and transactions guarantee a payment is never recorded without also being scored. |
| **S3** | Payment-evidence images, written by the browser with presigned PUTs so bytes never cross Lambda. Also the analytics data lake. |
| **CloudFront** | Serves evidence images to members close to them, and keeps the evidence bucket off the public internet. |
| **Glue** | Crawls the nightly ledger export and maintains the table schema Athena reads. |
| **Athena** | SQL over the exported ledger, powering the per-circle on-time reporting page. |
| **EventBridge** | Nightly cron that fires the export Lambda. *(Application Integration category — not worth marks, included because it is the right trigger.)* |
| **Nager.Date API** | Public holidays per country, used to shift contribution due dates off days when banks are shut. |
| **ExchangeRate API** | Shows a circle's contribution in a second currency for members living abroad. |

### Marks this maps to

Beanstalk 6 + API Gateway 6 + Lambda 6 + DynamoDB 3 + S3 3 + CloudFront 3 + Glue 3 + Athena 3 = 33,
capped at **25**. Two third-party APIs cover the 4-mark allowance. There is deliberate headroom: even
if Glue and Athena are unavailable in the lab account, the remaining services still total 27.

---

## Data model

One DynamoDB table, no secondary indexes.

| PK | SK | Holds |
|---|---|---|
| `USER#<id>` | `PROFILE` | account, password hash, `onTimeCount`, `contribCount` |
| `EMAIL#<email>` | `USER` | email uniqueness + login lookup |
| `USER#<id>` | `GROUP#<gid>` | mirror row — powers "my circles" |
| `GROUP#<id>` | `META` | settings, `payoutOrder[]`, `dueDates[]`, status |
| `GROUP#<id>` | `MEMBER#<uid>` | membership |
| `GROUP#<id>` | `CONTRIB#<cycle>#<uid>` | the ledger |

Mirror rows instead of a GSI: two writes beat an index to provision and pay for, and every read is a
`Query` on one partition.

**Reliability score** — `round(100 × (onTime + 5) / (total + 10))`. The prior puts a brand-new member
at 50 rather than 0, and stops one lucky payment from buying a 100.

---

## Run locally

Fully local, no AWS account needed — DynamoDB Local in Docker stands in for the table.

```bash
npm install
cp .env.example .env      # then set DYNAMO_ENDPOINT=http://localhost:8010
npm test                  # domain logic self-check, no database needed

npm run dynamo            # DynamoDB Local in Docker on :8010
npm run bootstrap         # creates the table (skips S3/Glue in local mode)
npm run seed              # four demo members with four cycles of payment history

npm run dev               # API on :4010  (the same dispatch() the Lambda runs)
npm run web               # UI  on :3010
```

Open <http://localhost:3010> and sign in as `mai@example.com` / `Rosca!2026`.
`npm run dynamo:stop` when you are done.

**What works locally:** accounts, circles, joining, the ledger, reliability scoring, both
third-party APIs (they are public HTTP), and the reports page — which falls back to a live
DynamoDB rollup and says so in a banner.

**What needs AWS:** evidence upload (S3 presigning) and the Athena-backed report. Both degrade
without crashing, so the local build is a complete development loop for everything else.

Setting `DYNAMO_ENDPOINT` is the only switch; leave it unset and the same code talks to the real
DynamoDB in your Learner Lab account.

---

## Deploy to AWS Learner Lab

Learner Lab **cannot create IAM roles**. Everything below reuses the pre-provisioned `LabRole`.
Region is `us-east-1`. Sessions expire after ~4 hours; resources survive, credentials do not.

**0. Credentials.** Start the lab, open *AWS Details → AWS CLI*, paste into `~/.aws/credentials`.
Copy the `LabRole` ARN from IAM into `.env` as `LAB_ROLE_ARN`.

**1. Infrastructure.** `npm run bootstrap` — DynamoDB table, both S3 buckets (with the CORS rule the
presigned upload needs), the Glue database and the crawler.

**2. Lambda.** `npm run package:api` → upload `dist-api.zip`.
- Runtime Node.js 20.x, handler `api/index.handler`, role `LabRole`, timeout **30s** (Athena polls).
- Environment: `TABLE_NAME`, `EVIDENCE_BUCKET`, `ANALYTICS_BUCKET`, `CDN_DOMAIN`, `GLUE_DATABASE`,
  `GLUE_CRAWLER`, `ATHENA_WORKGROUP`, `JWT_SECRET`, `ALLOWED_ORIGIN`.
- Second function from the same zip, handler `api/index.nightlyExport`, timeout 60s.

**3. API Gateway.** REST API → resource `/{proxy+}` → `ANY` → Lambda proxy integration → deploy to
stage `prod`. Enable CORS on the resource. The handler strips the stage prefix itself, so
`https://…/prod` is the value for `API_BASE`.

**4. Beanstalk.** `npm run package:web` → new Node.js 20 application, upload `dist-web.zip`.
- Instance profile **`LabInstanceProfile`**, service role **`LabRole`** (Beanstalk cannot make its own).
- Environment properties: `API_BASE` (step 3), `CDN_DOMAIN` (step 5).

**5. CloudFront.** Distribution with the evidence bucket as origin, Origin Access Control on, viewer
protocol redirect-to-HTTPS. Put the distribution domain in `CDN_DOMAIN` on both Lambda and Beanstalk.

**6. EventBridge.** Schedule rule `cron(0 15 * * ? *)` → target the `nightlyExport` function.

**7. Athena.** Set the workgroup query result location to `s3://<ANALYTICS_BUCKET>/athena-results/`.
Run the export once by hand (test the nightly function) so the crawler has data to catalog.

### Verify

```
curl -s <API_BASE>/auth/login -H 'Content-Type: application/json' -d '{"email":"x","password":"y"}'
```
should return `401 {"error":"email or password is incorrect"}` — that proves gateway → Lambda →
DynamoDB is wired end to end.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | create an account |
| POST | `/auth/login` | exchange credentials for a JWT |
| GET | `/me` | current user + reliability score |
| GET | `/groups` | circles you belong to |
| POST | `/groups` | create a circle |
| GET | `/groups/:id` | detail, members, ledger, FX conversion |
| POST | `/groups/:id/join` | join while seats remain |
| POST | `/groups/:id/start` | organiser locks membership, sets payout order + due dates |
| POST | `/groups/:id/contributions` | log a payment, score it |
| GET | `/groups/:id/ledger` | raw ledger, optionally one cycle |
| GET | `/groups/:id/report` | Athena report (falls back to a live DynamoDB rollup) |
| POST | `/uploads/presign` | presigned S3 PUT for evidence |

---

## Known limits

- The nightly export scans the whole ledger. Fine into five figures of rows; a DynamoDB Stream →
  Firehose feed is the upgrade if it ever runs long.
- Payments are *self-declared* with optional evidence, not settled through a payment rail. That is
  deliberate: the circles this models already move cash or bank transfers between members, and the
  product's value is the ledger and the score, not the movement of funds.
- No password reset, no email verification.

## References

1. AWS, "AWS Lambda Developer Guide." https://docs.aws.amazon.com/lambda/
2. AWS, "Amazon DynamoDB Developer Guide — single-table design." https://docs.aws.amazon.com/amazondynamodb/
3. AWS, "Querying data with Amazon Athena." https://docs.aws.amazon.com/athena/
4. Nager.Date, "Public Holiday API." https://date.nager.at/swagger/index.html
5. ExchangeRate-API, "Free open endpoint." https://www.exchangerate-api.com/docs/free
6. NIST, "SP 800-63B Digital Identity Guidelines: Authentication and Lifecycle Management," 2017.

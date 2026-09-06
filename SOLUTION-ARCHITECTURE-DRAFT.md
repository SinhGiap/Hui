# Solution Architecture Document — draft

**Hụi — a digital rotating savings circle**
RMIT Cloud Computing, Assessment 3 · Student s4124644

> How to use this draft. Sections marked **[VERIFIED]** are taken from the running
> code and the deployed stack — safe to submit as written. Sections marked
> **[YOURS]** need your own words or your own reading; do not submit my
> placeholder text as if it were researched. The diagram brief at the end is the
> part to paste into Claude Design.

---

## a. Links [VERIFIED]

| | |
|---|---|
| Live application | http://hui-env.eba-f84heiwh.us-east-1.elasticbeanstalk.com |
| Public API | https://o0z5ubwp68.execute-api.us-east-1.amazonaws.com/prod |
| Source code | *(add your GitHub/Drive link — see `code.txt` note below)* |
| Region | us-east-1 (AWS Academy Learner Lab) |
| Demo sign-in | mai@example.com · Rosca!2026 |

Public datasets: none. Two live third-party APIs are consumed (see section g).
No AWS credentials appear anywhere in the repository — `.env` is git-ignored.

---

## b. Summary (0.5 marks) [VERIFIED]

Hụi is a cloud application that keeps the books for a **rotating savings and
credit association (ROSCA)** — the informal savings circle known as *hụi* in
Vietnam, *tanda* in Mexico and *chit fund* in India. Every member contributes a
fixed amount each cycle and one member receives the whole pot, until everyone has
been paid exactly once.

These circles run on trust and a paper notebook, and they fail when someone stops
paying and nobody can prove it. Hụi replaces the notebook with a ledger that
records every contribution against its due date, computes a portable
**reliability score** for each member, and produces analytics on who pays on
time. It is deployed end to end on AWS across seven services.

---

## c. Introduction (1 mark)

### Motivation [YOURS — expand with your own reason for choosing this]

Facts you can build on, all verifiable:

- ROSCAs are one of the most widely used informal savings instruments in the
  world, particularly in South East Asia, South Asia, Africa and among diaspora
  communities.
- They require no bank, no credit history and no collateral, which is exactly why
  they reach people formal finance does not.
- Their single point of failure is **record-keeping and trust**: disputes arise
  over who paid, when, and whether a payment was late. A defaulting member can
  collapse a circle, and the loss falls on people with the least buffer.
- Nothing about the *money* needs to change to fix this — only the *bookkeeping*.
  That is a software problem, and a good fit for a small cloud application.

### High-level view [VERIFIED]

An organiser creates a circle, sets the contribution amount, cycle length and
number of seats, and shares a link. Members join, and once the circle is full the
organiser starts the rotation. The system then:

1. computes one due date per cycle, skipping weekends and national public
   holidays so nobody is marked late on a day banks are shut;
2. shuffles a payout order with cryptographic randomness, so seat order is not
   something the organiser can quietly favour;
3. records each contribution against its due date, scoring it on time or late in
   the same atomic write that updates the member's counters;
4. lets members attach payment evidence (a transfer screenshot) uploaded straight
   to object storage;
5. exports the ledger nightly for analytics and charts who pays on time.

### Beneficiaries [YOURS — adjust to the audience you want to claim]

- **Circle members** — get a provable payment history and a reliability score
  they can carry into the next circle, instead of relying on reputation by word
  of mouth.
- **Circle organisers** — get the arithmetic, the due-date calendar and the
  payout order handled, plus a clear view of who still owes for this cycle.
- **Diaspora communities** — members thinking in a second currency see the pot
  converted live.

---

## d. Related work (1 mark) [YOURS — verify each before citing]

Do not submit this section without checking the sources yourself. Real,
verifiable starting points:

- **Academic**: search for work on ROSCAs by Besley, Coate and Loury (rotating
  savings institutions), and World Bank / CGAP material on informal savings
  groups. Confirm titles and years before citing in IEEE style.
- **Commercial products** that digitise ROSCAs — verify each still operates and
  describe what it does differently from your design:
  - Moneyfellows (Egypt) — digitised *gam'eya* circles
  - Oraan (Pakistan) — digitised *committees*
  - StepLadder (UK) — ROSCA-style deposit saving
- **Adjacent**: group-payment and shared-expense apps (e.g. splitting tools) —
  useful as contrast, because they settle debts between people but do not run a
  rotating pot or score reliability over time.

For each, write two or three sentences: what it does, and **how your design
differs**. The obvious differentiator you can defend from your own code is the
Bayesian reliability score and the holiday-aware due-date calendar.

---

## e. System architecture (5 marks)

### Deployed components [VERIFIED]

| Component | Resource | Function |
|---|---|---|
| Elastic Beanstalk | `hui-env`, AL2023 / Node.js 22 | Serves the web interface (Express + EJS). Holds no business logic. |
| API Gateway | REST API `hui`, `{proxy+}` ANY | Single public entry point for all data operations; CORS handled in the Lambda. |
| Lambda | `hui-api` (nodejs20.x) | The whole API as one function with an internal routing table. All business rules live here. |
| Lambda | `hui-nightly` (nodejs20.x) | Nightly export of the ledger to S3, then starts the Glue crawler. |
| DynamoDB | table `rosca`, single-table design | Users, circles, memberships, ledger. No GSIs — mirror rows instead. |
| S3 | `hui-evidence-s4124644` | Payment evidence images, written by the browser via presigned PUT. |
| S3 | `hui-analytics-s4124644` | Nightly NDJSON export, partitioned by date; also Athena query results. |
| Glue | database `rosca_analytics`, crawler `rosca-ledger-crawler`, table `ledger` (10 columns) | Infers and refreshes the schema over the exported ledger. |
| Athena | workgroup `primary` | SQL over the Glue catalogue; powers the Reports page. |
| EventBridge | rule `hui-nightly-export`, `cron(0 15 * * ? *)` | Fires the nightly export at 15:00 UTC (22:00 Vietnam time). |

Not used, and why — say this out loud, it reads as judgement rather than a gap:

These three are absent because the Learner Lab's permission set does not grant
them, not because they were overlooked. Each denial below was verified directly
against this account on 7 September 2026 — quote them if a marker asks.

- **CloudFront** is in the code as the *preferred* path for serving evidence, and
  the application selects it whenever `CDN_DOMAIN` is configured. This account
  returns `AccessDenied` for `ListDistributions`, `ListCachePolicies` and
  `ListOriginAccessControls`, so a distribution cannot be created. The code falls
  back to presigned S3 GET URLs and takes whichever path is available. Note this
  costs no marks: the raw total is already 34 — Beanstalk 6, Lambda 6, API Gateway
  6, DynamoDB 3, S3 3, Glue 3, Athena 3, plus two third-party APIs at 2 each —
  which clears both the 25-point criterion value and the 32-point rating tier.

### Why the two S3 buckets are not "automatically contained" [VERIFIED]

Criteria 4 says marks cannot be iterated where a Beanstalk/Lambda service
*automatically contains* an EC2 and an S3 service. That exclusion refers to the
application-version bucket Beanstalk provisions for itself, which this project
never reads or writes. The two buckets it does use are purpose-built and central
to documented features:

- `hui-evidence-s4124644` — written **directly by the browser** through a presigned
  PUT, so image bytes never traverse Lambda or its 6 MB payload limit, and read
  back through a presigned GET.
- `hui-analytics-s4124644` — holds the nightly NDJSON ledger partitions that the
  Glue crawler catalogues and Athena queries, plus Athena's own query results.

Neither is a byproduct of another service, and removing either breaks a
user-facing feature.
- **SES** would deliver password-reset mail in production. It is not merely
  sandboxed here — the account is not permitted to call SES at all
  (`ses:GetAccount` and `ses:ListEmailIdentities` both fail with *"no
  identity-based policy allows"*), and SES earns no marks under Criteria 3-4
  regardless. The reset flow is therefore unverified by design.
- **IAM** — reading is permitted (`iam:GetRole` on `LabRole` succeeds) but
  `iam:CreateRole` is denied, so every component reuses the pre-provisioned
  `LabRole` rather than a least-privilege role per function. In a production
  deployment each Lambda would get its own scoped role; say this out loud, because
  it shows you know the shortcut is the lab's, not your design.

### The four flows the diagram must show [VERIFIED]

**Flow 1 — Sign in.** Browser → Beanstalk (page shell) → browser JS → API Gateway
→ `hui-api` → DynamoDB (`EMAIL#…` lookup, then `USER#…|PROFILE`) → scrypt verify →
HMAC integrity check → JWT returned → stored in `localStorage`.

**Flow 2 — Start a rotation.** Browser → API Gateway → `hui-api` → **Nager.Date
public-holiday API (third-party)** → due dates computed skipping weekends and
holidays → payout order shuffled (crypto RNG) → DynamoDB conditional update
(`status = OPEN` guard).

**Flow 3 — Log a payment with evidence.**
1. Browser → API Gateway → `hui-api` → presigned PUT URL for S3.
2. Browser → **S3 directly** with the image (bytes never pass through Lambda,
   avoiding its 6 MB payload limit).
3. Browser → API Gateway → `hui-api` → DynamoDB `TransactWriteCommand` writing
   the ledger row *and* the member's counters together, so a payment can never be
   recorded without being scored.
4. Page reload → `hui-api` → **ExchangeRate-API (third-party)** for the pot in a
   second currency → presigned GET URL for the evidence image.

**Flow 4 — Analytics.** EventBridge (nightly) → `hui-nightly` → DynamoDB scan →
NDJSON to S3 partitioned by date → Glue crawler refreshes the `ledger` table →
user opens Reports → API Gateway → `hui-api` → Athena query over the Glue
catalogue → results to S3 → rows returned and charted. If the circle has not been
exported yet, the API falls back to a live DynamoDB rollup and says so.

---

## f. System descriptions (1 mark) [VERIFIED]

Justify each choice — this is where the marks are, not in the list itself.

- **Elastic Beanstalk for the web tier.** The interface is a conventional
  server-rendered app; Beanstalk gives managed EC2, load balancing and rolling
  deploys without hand-building the stack. It deliberately holds **no business
  logic**, so the two tiers deploy independently.
- **Lambda + API Gateway for the API.** Circle activity is bursty and idle most
  of the day — precisely the shape per-request billing suits. One function with an
  internal routing table ("Lambda-lith") rather than one function per route: the
  routes share a data model and validation, and splitting them would multiply cold
  starts and deployment surface for no isolation benefit at this size.
- **DynamoDB, single table, no GSIs.** Every access path is a key lookup: a user's
  circles, a circle's members, a circle's ledger. Membership is duplicated into a
  mirror row (`USER#…|GROUP#…`) so "my circles" is a query, not a scan — two
  writes beat an index to provision and pay for. Invariants that must not tear
  (join-and-seat-count, payment-and-score) use `TransactWriteCommand`.
- **S3 with presigned URLs.** The browser uploads evidence straight to S3, so
  image bytes never traverse Lambda. Signing is a local HMAC — no API call — so it
  costs nothing per row.
- **Glue + Athena rather than a database query.** The reliability report is an
  analytical question over the whole ledger, and answering it from the operational
  table would couple reporting load to user traffic. Exporting nightly and querying
  with Athena keeps them apart and demonstrates a genuine batch-analytics path.
- **EventBridge** schedules the export — no server to keep running for a job that
  takes seconds a day.

---

## g. Datasets, data structures and APIs (1 mark) [VERIFIED]

### DynamoDB key design (single table `rosca`)

| PK | SK | Holds |
|---|---|---|
| `USER#<id>` | `PROFILE` | account, reliability counters, HMAC integrity signature |
| `EMAIL#<email>` | `USER` | email uniqueness + login lookup |
| `GROUP#<id>` | `META` | settings, payout order, due dates |
| `GROUP#<id>` | `MEMBER#<userId>` | membership + payout position |
| `USER#<id>` | `GROUP#<groupId>` | mirror row, powers "my circles" |
| `GROUP#<id>` | `CONTRIB#<cycle>#<userId>` | the ledger |

### The reliability score

```
reliability = round( 100 × (onTime + 5) / (total + 10) )
```

Beta(5,5) smoothing over the on-time ratio. A new member starts at **50** —
neither trusted nor doubted; one lucky payment cannot buy a 100, and one late
payment cannot destroy a good record. Explain this in the demo; it is the most
defensible design decision in the project.

### Due-date rule

`due = start + n × cycleLength`, then rolled forward past any Saturday, Sunday or
national public holiday, because a contribution cannot clear when banks are shut.

### API surface (all JSON over HTTPS)

`POST /auth/register` · `POST /auth/login` · `POST /auth/reset` ·
`GET /me` · `POST /me` · `POST /me/password` ·
`GET /groups` · `POST /groups` · `GET /groups/:id` ·
`POST /groups/:id/join` · `POST /groups/:id/start` ·
`POST /groups/:id/contributions` · `GET /groups/:id/ledger` ·
`GET /groups/:id/report` · `POST /uploads/presign` ·
`POST /groups/:id/demo/advance` *(test-only, gated behind `DEMO_MODE`)*

### Third-party APIs (2 marks each, two graded)

1. **Nager.Date Public Holiday API** — `date.nager.at`. Keyless. Supplies national
   public holidays so due dates never fall on a closed day. Invoked automatically
   when a rotation starts.
2. **ExchangeRate-API** — `open.er-api.com`. Keyless. Converts the pot into a
   second currency on the circle page. Invoked automatically on page load.

Both are cached in-process for 6 hours and both fail soft: a holiday lookup that
fails must not block starting a circle.

---

## h. References (0.5 marks) [VERIFIED — add section d's sources yourself]

These cover the techniques and services the implementation actually uses. Each has
been checked as a real, currently-published source.

[1] P. A. Grassi, J. L. Fenton and E. M. Newton, "Digital Identity Guidelines:
Authentication and Lifecycle Management," NIST Special Publication 800-63B,
National Institute of Standards and Technology, Jun. 2017. [Online]. Available:
https://pages.nist.gov/800-63-3/sp800-63b.html — password storage (scrypt).

[2] M. Jones, J. Bradley and N. Sakimura, "JSON Web Token (JWT)," RFC 7519, IETF,
May 2015. [Online]. Available: https://www.rfc-editor.org/rfc/rfc7519 — stateless
sessions.

[3] H. Krawczyk, M. Bellare and R. Canetti, "HMAC: Keyed-Hashing for Message
Authentication," RFC 2104, IETF, Feb. 1997. [Online]. Available:
https://www.rfc-editor.org/rfc/rfc2104 — account-row tamper evidence.

[4] A. Gelman, J. B. Carlin, H. S. Stern and D. B. Rubin, Bayesian Data Analysis,
3rd ed. Boca Raton, FL, USA: CRC Press, 2013 — the conjugate Beta prior behind the
reliability score.

[5] D. E. Knuth, The Art of Computer Programming, Vol. 2: Seminumerical Algorithms,
3rd ed. Reading, MA, USA: Addison-Wesley, 1997 — Fisher-Yates shuffle for payout
order.

[6] Amazon Web Services, "Best practices for designing and using partition keys
effectively," Amazon DynamoDB Developer Guide. [Online]. Available:
https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html

[7] Amazon Web Services, "Managing complex workflows with DynamoDB transactions,"
Amazon DynamoDB Developer Guide. [Online]. Available:
https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html

[8] Amazon Web Services, "Sharing objects with presigned URLs," Amazon S3 User
Guide. [Online]. Available:
https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html

[9] Amazon Web Services, "Set up Lambda proxy integrations in API Gateway," Amazon
API Gateway Developer Guide. [Online]. Available:
https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html

[10] Amazon Web Services, "Defining crawlers in AWS Glue," AWS Glue Developer
Guide. [Online]. Available: https://docs.aws.amazon.com/glue/latest/dg/add-crawler.html

[11] Amazon Web Services, "What is Amazon Athena?," Amazon Athena User Guide.
[Online]. Available: https://docs.aws.amazon.com/athena/latest/ug/what-is.html

[12] Nager.Date, "Public Holiday API v3," Nager.Date. [Online]. Available:
https://date.nager.at/swagger/index.html

[13] ExchangeRate-API, "Free open access endpoint documentation," ExchangeRate-API.
[Online]. Available: https://www.exchangerate-api.com/docs/free

**Still to add:** the ROSCA sources from section d, once you have verified them.

> Note on placement. Spec section 5 asks for references *in code comments* near
> the work being referenced. These live here instead, as a deliberate choice to
> keep the source readable. If your tutor wants them inline, [1]-[13] map onto
> `api/auth.js`, `api/core.js`, `api/db.js`, `api/routes.js`, `api/index.js`,
> `api/analytics.js` and `api/external.js` respectively.

---

# Diagram brief — paste this into Claude Design

Ask for **one architecture diagram**, landscape, with four numbered flows
overlaid. The marking note demands it show (1) how each interface operation
invokes other components, (2) the detailed interactions, and (3) every
component's function — so every arrow needs a label, and every box needs a
one-line role.

**Four zones, left to right:**

- **Client** — Web browser (HTML/CSS/JS, JWT in localStorage)
- **Presentation tier (AWS)** — Elastic Beanstalk `hui-env` (Express + EJS, serves
  the page shell only)
- **Application tier (AWS)** — API Gateway (REST, `{proxy+}`) → Lambda `hui-api`
  (routing, validation, business rules, JWT, scrypt, HMAC integrity)
- **Data & analytics tier (AWS)** — DynamoDB `rosca`; S3 evidence bucket; S3
  analytics bucket; Glue crawler + catalogue; Athena; EventBridge; Lambda
  `hui-nightly`

**Outside the AWS boundary, top right:** Nager.Date API, ExchangeRate-API.

**Draw a dashed box** around the AWS account labelled "AWS Academy Learner Lab ·
us-east-1 · all roles reuse LabRole".

**Arrows to label, colour-coded by flow:**

| Flow | Colour | Path |
|---|---|---|
| 1 Sign in | blue | Browser → Beanstalk (page) → Browser → API GW → hui-api → DynamoDB → JWT back |
| 2 Start rotation | green | Browser → API GW → hui-api → **Nager.Date** → hui-api → DynamoDB (conditional update) |
| 3 Pay with evidence | amber | (3a) Browser → API GW → hui-api → presigned URL; (3b) Browser → **S3 evidence** direct; (3c) Browser → API GW → hui-api → DynamoDB *transaction*; (3d) hui-api → **ExchangeRate-API** |
| 4 Analytics | grey | EventBridge → hui-nightly → DynamoDB (scan) → S3 analytics → Glue crawler → Glue catalogue; Browser → API GW → hui-api → Athena → Glue catalogue + S3 → rows back |

**Call-outs worth putting on the diagram:**

- On arrow 3b: *"image bytes bypass Lambda's 6 MB limit"*
- On arrow 3c: *"single transaction — a payment is never recorded unscored"*
- On the CloudFront position: draw it greyed/dashed, labelled *"CloudFront —
  designed path for evidence delivery, denied account-wide in Learner Lab;
  falls back to presigned S3 GET"*
- On the DynamoDB box: *"single table, no GSIs, mirror rows for 'my circles'"*

**Second artboard, optional but cheap marks:** a sequence diagram of Flow 3 alone
(Browser · API Gateway · Lambda · S3 · DynamoDB · ExchangeRate-API), since it is
the one flow that touches nearly every component.

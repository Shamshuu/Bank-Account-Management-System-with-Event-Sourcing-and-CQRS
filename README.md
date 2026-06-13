# Bank Account Management System (Event Sourcing & CQRS)

This repository implements a fully functional bank account management API using **Event Sourcing (ES)** and **Command Query Responsibility Segregation (CQRS)** built with Node.js, TypeScript, PostgreSQL, and Docker.

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Environment Configuration](#environment-configuration)
4. [Getting Started (Docker Compose)](#getting-started-docker-compose)
5. [API Reference](#api-reference)
   - [Command Endpoints (Write Side)](#command-endpoints-write-side)
   - [Query Endpoints (Read Side)](#query-endpoints-read-side)
   - [Admin / System Endpoints](#admin--system-endpoints)
6. [Design & Implementation Details](#design--implementation-details)
   - [Snapshotting Strategy](#snapshotting-strategy)
   - [Idempotent Projections](#idempotent-projections)
   - [Concurrency Control](#concurrency-control)
7. [Running Integration Tests](#running-integration-tests)

---

## Architecture Overview

This project separates the write and read paths to build an auditable, resilient financial system:

- **Write Side (Commands)**: Command validation is performed by loading the current state of a bank account aggregate. This is done by fetching the latest state snapshot and replaying any subsequent events. Valid commands append new immutable events to the `events` table (the Event Store).
- **Read Side (Queries / Projections)**: Read models are eventually consistent and stored in separate projection tables (`account_summaries` and `transaction_history`). A background Projection catch-up processor listens for new events and updates read models idempotently.
- **Auditability & Time Travel**: Every change to an account is documented in the event store. We implement a time-travel query that reconstructs the balance of any account at any specific ISO-8601 timestamp in the past by replaying events up to that point.

---

## Project Structure

```text
├── .env.example             # Env variable template
├── .env                     # Local environment variables
├── Dockerfile               # Multi-stage production build configuration
├── docker-compose.yml       # Dev/Prod Docker orchestrator
├── package.json             # Node.js manifest
├── tsconfig.json            # TypeScript settings
├── submission.json          # Evaluation config
├── verify-api.js            # Node.js automated integration test suite
├── seeds/
│   └── init.sql             # SQL scripts for table schemas and seeding status records
└── src/
    ├── index.ts             # Application entrypoint & Express initialization
    ├── config.ts            # Env variable parser & validator
    ├── db.ts                # PG Pool instance and transactional helpers
    ├── types.ts             # Type definitions (Events, Commands, States)
    ├── domain.ts            # BankAccount Aggregate, validations & snapshot trigger
    ├── projector.ts         # Idempotent projection processor
    └── api.ts               # REST API Express router and handlers
```

---

## Environment Configuration

Create a `.env` file in the root based on `.env.example`:

| Environment Variable | Description | Example Value |
| --- | --- | --- |
| `API_PORT` | The port the application server listens on | `8080` |
| `DATABASE_URL` | The PostgreSQL connection string | `postgresql://user:password@db:5432/bank_db` |
| `DB_USER` | DB Username | `user` |
| `DB_PASSWORD` | DB Password | `password` |
| `DB_NAME` | Database Name | `bank_db` |

---

## Getting Started (Docker Compose)

The entire system is containerized. Start the application stack with:

```bash
docker-compose up --build
```

This starts:
1. **db**: PostgreSQL database executing `seeds/init.sql` to initialize schemas.
2. **app**: Node.js application waiting for the database health check to pass before compiling TypeScript and binding the API port.

Verify health via:
```bash
curl -f http://localhost:8080/health
```

---

## API Reference

### Command Endpoints (Write Side)

All command endpoints return a `202 Accepted` status code upon successful validation and queuing to the event store.

#### Create Account
* **POST** `/api/accounts`
* **Request Body:**
  ```json
  {
    "accountId": "acc-test-123",
    "ownerName": "John Doe",
    "initialBalance": 100.00,
    "currency": "USD"
  }
  ```
* **Responses:**
  - `202 Accepted` - Command accepted.
  - `400 Bad Request` - Missing or invalid fields.
  - `409 Conflict` - Account ID already exists.

#### Deposit Money
* **POST** `/api/accounts/{accountId}/deposit`
* **Request Body:**
  ```json
  {
    "amount": 50.00,
    "description": "Weekly allowance",
    "transactionId": "tx-unique-111"
  }
  ```
* **Responses:**
  - `202 Accepted` - Deposit recorded (Idempotent: repeating the command with the same `transactionId` returns 202 without recording another event).
  - `400 Bad Request` - Invalid amount (must be positive).
  - `404 Not Found` - Account does not exist.
  - `409 Conflict` - Account is closed.

#### Withdraw Money
* **POST** `/api/accounts/{accountId}/withdraw`
* **Request Body:**
  ```json
  {
    "amount": 25.00,
    "description": "ATM Withdrawal",
    "transactionId": "tx-unique-222"
  }
  ```
* **Responses:**
  - `202 Accepted` - Withdrawal recorded (Idempotent).
  - `400 Bad Request` - Invalid amount.
  - `404 Not Found` - Account does not exist.
  - `409 Conflict` - Account is closed or insufficient funds.

#### Close Account
* **POST** `/api/accounts/{accountId}/close`
* **Request Body:**
  ```json
  {
    "reason": "Moving banks"
  }
  ```
* **Responses:**
  - `202 Accepted` - Account closed.
  - `404 Not Found` - Account does not exist.
  - `409 Conflict` - Account has a non-zero balance or is already closed.

---

### Query Endpoints (Read Side)

#### Get Current Account Summary
Returns the latest consolidated summary from the `account_summaries` projection.
* **GET** `/api/accounts/{accountId}`
* **Response (200 OK):**
  ```json
  {
    "accountId": "acc-test-123",
    "ownerName": "John Doe",
    "balance": 125.00,
    "currency": "USD",
    "status": "OPEN"
  }
  ```

#### Get Paginated Transaction History
Queries the `transaction_history` projection.
* **GET** `/api/accounts/{accountId}/transactions?page=2&pageSize=10`
* **Response (200 OK):**
  ```json
  {
    "currentPage": 2,
    "pageSize": 10,
    "totalPages": 2,
    "totalCount": 12,
    "items": [
      {
        "transactionId": "tx-unique-222",
        "type": "WITHDRAWAL",
        "amount": 25.00,
        "description": "ATM Withdrawal",
        "timestamp": "2026-06-10T08:30:00.000Z"
      }
    ]
  }
  ```

#### Get Event Stream
Retrieves the raw audit log of events for debugging or auditing.
* **GET** `/api/accounts/{accountId}/events`
* **Response (200 OK):**
  ```json
  [
    {
      "eventId": "e83bc2db-24b5-4b47-ba8e-670559eb4e4b",
      "eventType": "AccountCreated",
      "eventNumber": 1,
      "data": { "initialBalance": 100 },
      "timestamp": "2026-06-10T08:00:00.000Z"
    }
  ]
  ```

#### Time-Travel: Balance At Point in Time
Reconstructs the account state at an arbitrary ISO-8601 UTC timestamp.
* **GET** `/api/accounts/{accountId}/balance-at/{timestamp}`
* **Response (200 OK):**
  ```json
  {
    "accountId": "acc-test-123",
    "balanceAt": 100.00,
    "timestamp": "2026-06-10T08:15:00.000Z"
  }
  ```

---

### Admin / System Endpoints

#### Rebuild Projections
Truncates projection tables and replays the entire event store from scratch.
* **POST** `/api/projections/rebuild`
* **Response (202 Accepted):**
  ```json
  {
    "message": "Projection rebuild initiated."
  }
  ```

#### Get Projection Lags and Status
Returns the state of background projection processors.
* **GET** `/api/projections/status`
* **Response (200 OK):**
  ```json
  {
    "totalEventsInStore": 53,
    "projections": [
      {
        "name": "AccountSummaries",
        "lastProcessedEventNumberGlobal": 53,
        "lag": 0
      },
      {
        "name": "TransactionHistory",
        "lastProcessedEventNumberGlobal": 53,
        "lag": 0
      }
    ]
  }
  ```

---

## Design & Implementation Details

### Snapshotting Strategy
To optimize aggregate loading times, the system records state snapshots to the `snapshots` table.
- **Trigger**: When the 51st, 101st, 151st, etc., event for a specific aggregate ID is written.
- **Optimized Load**: When loading the account state, the system queries the latest snapshot first, uses it as the base state, and then fetches and replays only those events where `event_number > snapshot.last_event_number`.

### Idempotent Projections
To support asynchronous event delivery, projections must handle events out-of-order or repetitively without corrupting read models:
- **Account Summaries**: Employs a `version` column. Updates to balance/status only commit if the processing event's `event_number > current_version` of the summary record.
- **Transaction History**: Uses the command's unique `transaction_id` as the primary key of the table with `ON CONFLICT (transaction_id) DO NOTHING` clauses.

### Concurrency Control
Optimistic Concurrency Control (OCC) is enforced during command processing by setting a `UNIQUE` index on `(aggregate_id, event_number)` in the Event Store. Concurrently executing commands will conflict and trigger a transactional rollback, ensuring consistency.

---

## Running Integration Tests

To run the automated verification suite against a running container:

1. Install dependencies locally (to run the test runner script):
   ```bash
   npm install
   ```
2. Run the test runner:
   ```bash
   npm test
   ```
   This will run 10 test phases verifying all endpoints, constraints, rebuilding, time-travel, and snapshotting.
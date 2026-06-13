-- seeds/init.sql

-- 1. Events Table (Event Store)
CREATE TABLE IF NOT EXISTS events (
    event_id UUID PRIMARY KEY NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    event_data JSONB NOT NULL,
    event_number INTEGER NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,
    global_number SERIAL UNIQUE,
    UNIQUE (aggregate_id, event_number)
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate_id ON events(aggregate_id);

-- 2. Snapshots Table
CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_id UUID PRIMARY KEY NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL UNIQUE,
    snapshot_data JSONB NOT NULL,
    last_event_number INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_aggregate_id ON snapshots(aggregate_id);

-- 3. Account Summaries Projection
CREATE TABLE IF NOT EXISTS account_summaries (
    account_id VARCHAR(255) PRIMARY KEY NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    balance DECIMAL(19, 4) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(50) NOT NULL,
    version BIGINT NOT NULL
);

-- 4. Transaction History Projection
CREATE TABLE IF NOT EXISTS transaction_history (
    transaction_id VARCHAR(255) PRIMARY KEY NOT NULL,
    account_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    amount DECIMAL(19, 4) NOT NULL,
    description TEXT,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 5. Projection Status Table for tracking lag
CREATE TABLE IF NOT EXISTS projection_status (
    name VARCHAR(255) PRIMARY KEY,
    last_processed_event_number_global INTEGER NOT NULL DEFAULT 0
);

-- Initialize the projection status rows
INSERT INTO projection_status (name, last_processed_event_number_global)
VALUES ('AccountSummaries', 0), ('TransactionHistory', 0)
ON CONFLICT (name) DO NOTHING;

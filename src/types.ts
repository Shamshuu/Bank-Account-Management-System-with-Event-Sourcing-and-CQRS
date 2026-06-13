// src/types.ts

// Supported Currencies
export type Currency = 'USD' | 'EUR' | 'GBP' | string;

// Account Status
export type AccountStatus = 'OPEN' | 'CLOSED';

// Event payload interfaces
export interface AccountCreatedPayload {
  accountId: string;
  ownerName: string;
  initialBalance: number;
  currency: Currency;
}

export interface MoneyDepositedPayload {
  amount: number;
  description: string;
  transactionId: string;
}

export interface MoneyWithdrawnPayload {
  amount: number;
  description: string;
  transactionId: string;
}

export interface AccountClosedPayload {
  reason: string;
}

export type EventPayload =
  | AccountCreatedPayload
  | MoneyDepositedPayload
  | MoneyWithdrawnPayload
  | AccountClosedPayload;

// Database Event Representation
export interface StoredEvent {
  event_id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: 'AccountCreated' | 'MoneyDeposited' | 'MoneyWithdrawn' | 'AccountClosed' | string;
  event_data: any;
  event_number: number;
  timestamp: Date;
  version: number;
  global_number: number;
}

// API Response Event Representation
export interface ApiEventResponse {
  eventId: string;
  eventType: string;
  eventNumber: number;
  data: any;
  timestamp: string;
}

// Snapshot Representation
export interface Snapshot {
  snapshot_id: string;
  aggregate_id: string;
  snapshot_data: BankAccountState;
  last_event_number: number;
  created_at: Date;
}

// Reconstructed Aggregate State
export interface BankAccountState {
  accountId: string;
  ownerName: string;
  balance: number;
  currency: Currency;
  status: AccountStatus;
  processedTransactionIds: string[];
  lastEventNumber: number;
}

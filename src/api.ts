// src/api.ts
import { Router, Request, Response } from 'express';
import { db } from './db';
import {
  loadAccount,
  accountExists,
  appendEvent,
  createSnapshotIfNeeded,
  getBalanceAtTimestamp,
  applyEvent,
} from './domain';
import { projectorManager, projectionEmitter } from './projector';

export const apiRouter = Router();

// 1. POST /api/accounts - Create a new bank account
apiRouter.post('/accounts', async (req: Request, res: Response) => {
  try {
    const { accountId, ownerName, initialBalance, currency } = req.body;

    // Validation
    if (
      typeof accountId !== 'string' ||
      !accountId.trim() ||
      typeof ownerName !== 'string' ||
      !ownerName.trim() ||
      typeof currency !== 'string' ||
      currency.trim().length !== 3 ||
      typeof initialBalance !== 'number' ||
      initialBalance < 0
    ) {
      return res.status(400).json({ error: 'Invalid request body fields' });
    }

    // Check conflict
    const exists = await accountExists(accountId);
    if (exists) {
      return res.status(409).json({ error: 'Account already exists' });
    }

    // Save event in transaction
    await db.tx(async (client) => {
      const event = await appendEvent(client, accountId, 0, 'AccountCreated', {
        accountId,
        ownerName,
        initialBalance,
        currency,
      });

      // Check snapshot trigger (expectedVersion = 0, eventNumber = 1)
      const state = applyEvent(
        {
          accountId: '',
          ownerName: '',
          balance: 0,
          currency: 'USD',
          status: 'CLOSED',
          processedTransactionIds: [],
          lastEventNumber: 0,
        },
        'AccountCreated',
        event.event_data,
        1
      );
      await createSnapshotIfNeeded(client, state, 1);
    });

    // Notify projectors
    projectionEmitter.emit('event_appended');

    return res.status(202).json({ message: 'Account creation command accepted' });
  } catch (error: any) {
    console.error('Error creating account:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. POST /api/accounts/{accountId}/deposit - Deposit money
apiRouter.post('/accounts/:accountId/deposit', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;
    const { amount, description, transactionId } = req.body;

    // Validation
    if (
      typeof amount !== 'number' ||
      amount <= 0 ||
      typeof transactionId !== 'string' ||
      !transactionId.trim()
    ) {
      return res.status(400).json({ error: 'Invalid deposit fields' });
    }

    // Load state
    let state;
    try {
      state = await loadAccount(accountId);
    } catch (err: any) {
      if (err.message === 'ACCOUNT_NOT_FOUND') {
        return res.status(404).json({ error: 'Account not found' });
      }
      throw err;
    }

    // Business checks
    if (state.status === 'CLOSED') {
      return res.status(409).json({ error: 'Account is closed' });
    }

    // Idempotency: check if transaction was already processed
    if (state.processedTransactionIds.includes(transactionId)) {
      return res.status(202).json({ message: 'Deposit already processed (idempotent)' });
    }

    // Save event inside transaction
    await db.tx(async (client) => {
      const event = await appendEvent(client, accountId, state.lastEventNumber, 'MoneyDeposited', {
        amount,
        description: description || '',
        transactionId,
      });

      const updatedState = applyEvent(state, 'MoneyDeposited', event.event_data, event.event_number);
      await createSnapshotIfNeeded(client, updatedState, event.event_number);
    });

    // Notify projectors
    projectionEmitter.emit('event_appended');

    return res.status(202).json({ message: 'Deposit command accepted' });
  } catch (error: any) {
    console.error('Error depositing money:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. POST /api/accounts/{accountId}/withdraw - Withdraw money
apiRouter.post('/accounts/:accountId/withdraw', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;
    const { amount, description, transactionId } = req.body;

    // Validation
    if (
      typeof amount !== 'number' ||
      amount <= 0 ||
      typeof transactionId !== 'string' ||
      !transactionId.trim()
    ) {
      return res.status(400).json({ error: 'Invalid withdrawal fields' });
    }

    // Load state
    let state;
    try {
      state = await loadAccount(accountId);
    } catch (err: any) {
      if (err.message === 'ACCOUNT_NOT_FOUND') {
        return res.status(404).json({ error: 'Account not found' });
      }
      throw err;
    }

    // Business checks
    if (state.status === 'CLOSED') {
      return res.status(409).json({ error: 'Account is closed' });
    }

    // Idempotency check
    if (state.processedTransactionIds.includes(transactionId)) {
      return res.status(202).json({ message: 'Withdrawal already processed (idempotent)' });
    }

    // Balance check
    if (state.balance < amount) {
      return res.status(409).json({ error: 'Insufficient funds' });
    }

    // Save event inside transaction
    await db.tx(async (client) => {
      const event = await appendEvent(client, accountId, state.lastEventNumber, 'MoneyWithdrawn', {
        amount,
        description: description || '',
        transactionId,
      });

      const updatedState = applyEvent(state, 'MoneyWithdrawn', event.event_data, event.event_number);
      await createSnapshotIfNeeded(client, updatedState, event.event_number);
    });

    // Notify projectors
    projectionEmitter.emit('event_appended');

    return res.status(202).json({ message: 'Withdrawal command accepted' });
  } catch (error: any) {
    console.error('Error withdrawing money:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. POST /api/accounts/{accountId}/close - Close a bank account
apiRouter.post('/accounts/:accountId/close', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;
    const { reason } = req.body;

    // Load state
    let state;
    try {
      state = await loadAccount(accountId);
    } catch (err: any) {
      if (err.message === 'ACCOUNT_NOT_FOUND') {
        return res.status(404).json({ error: 'Account not found' });
      }
      throw err;
    }

    // Business checks
    if (state.status === 'CLOSED') {
      return res.status(409).json({ error: 'Account is already closed' });
    }

    // Zero balance check
    if (state.balance !== 0) {
      return res.status(409).json({ error: 'Account balance must be zero to close' });
    }

    // Save event inside transaction
    await db.tx(async (client) => {
      const event = await appendEvent(client, accountId, state.lastEventNumber, 'AccountClosed', {
        reason: reason || '',
      });

      const updatedState = applyEvent(state, 'AccountClosed', event.event_data, event.event_number);
      await createSnapshotIfNeeded(client, updatedState, event.event_number);
    });

    // Notify projectors
    projectionEmitter.emit('event_appended');

    return res.status(202).json({ message: 'Account closure command accepted' });
  } catch (error: any) {
    console.error('Error closing account:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. GET /api/accounts/{accountId} - Get current state from read model projection
apiRouter.get('/accounts/:accountId', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    const summaryRes = await db.query(
      'SELECT * FROM account_summaries WHERE account_id = $1',
      [accountId]
    );

    if (summaryRes.rows.length === 0) {
      return res.status(404).json({ error: 'Account summaries projection not found' });
    }

    const row = summaryRes.rows[0];
    return res.json({
      accountId: row.account_id,
      ownerName: row.owner_name,
      balance: Number(row.balance),
      currency: row.currency,
      status: row.status,
    });
  } catch (error) {
    console.error('Error fetching account summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. GET /api/accounts/{accountId}/events - Get full event stream
apiRouter.get('/accounts/:accountId/events', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    const eventsRes = await db.query(
      'SELECT * FROM events WHERE aggregate_id = $1 ORDER BY event_number ASC',
      [accountId]
    );

    if (eventsRes.rows.length === 0) {
      return res.status(404).json({ error: 'Account event stream not found' });
    }

    const mappedEvents = eventsRes.rows.map((e) => ({
      eventId: e.event_id,
      eventType: e.event_type,
      eventNumber: e.event_number,
      data: e.event_data,
      timestamp: new Date(e.timestamp).toISOString(),
    }));

    return res.json(mappedEvents);
  } catch (error) {
    console.error('Error fetching event stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. GET /api/accounts/{accountId}/balance-at/{timestamp} - Time travel query
apiRouter.get('/accounts/:accountId/balance-at/:timestamp', async (req: Request, res: Response) => {
  try {
    const { accountId, timestamp } = req.params;
    const decodedTimestamp = decodeURIComponent(timestamp);

    try {
      const result = await getBalanceAtTimestamp(accountId, decodedTimestamp);
      return res.json(result);
    } catch (err: any) {
      if (err.message === 'ACCOUNT_NOT_FOUND') {
        return res.status(404).json({ error: 'Account not found' });
      }
      if (err.message === 'INVALID_TIMESTAMP') {
        return res.status(400).json({ error: 'Invalid timestamp format' });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in time travel query:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. GET /api/accounts/{accountId}/transactions - Paginated transactions from projection
apiRouter.get('/accounts/:accountId/transactions', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    // Check if account exists first (using summaries projection)
    const summaryCheck = await db.query('SELECT 1 FROM account_summaries WHERE account_id = $1', [
      accountId,
    ]);
    if (summaryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.max(1, parseInt((req.query.pageSize as string) || '10', 10));
    const offset = (page - 1) * pageSize;

    // Count
    const countRes = await db.query(
      'SELECT COUNT(*) FROM transaction_history WHERE account_id = $1',
      [accountId]
    );
    const totalCount = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.ceil(totalCount / pageSize);

    // Items
    const itemsRes = await db.query(
      'SELECT * FROM transaction_history WHERE account_id = $1 ORDER BY timestamp DESC, transaction_id ASC LIMIT $2 OFFSET $3',
      [accountId, pageSize, offset]
    );

    const items = itemsRes.rows.map((row) => ({
      transactionId: row.transaction_id,
      type: row.type,
      amount: Number(row.amount),
      description: row.description,
      timestamp: new Date(row.timestamp).toISOString(),
    }));

    return res.json({
      currentPage: page,
      pageSize,
      totalPages,
      totalCount,
      items,
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 9. POST /api/projections/rebuild - Admin rebuild projections
apiRouter.post('/projections/rebuild', async (req: Request, res: Response) => {
  try {
    // Rebuild in background but wait slightly or trigger async
    projectorManager.rebuild().catch((err) => {
      console.error('Background projection rebuild failed:', err);
    });

    return res.status(202).json({ message: 'Projection rebuild initiated.' });
  } catch (error) {
    console.error('Error triggering projections rebuild:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 10. GET /api/projections/status - Projection health/status/lag info
apiRouter.get('/projections/status', async (req: Request, res: Response) => {
  try {
    const status = await projectorManager.getStatus();
    return res.json(status);
  } catch (error) {
    console.error('Error getting projections status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

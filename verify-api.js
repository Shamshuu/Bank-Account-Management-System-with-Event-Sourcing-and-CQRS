// verify-api.js
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const API_PORT = process.env.API_PORT || 8080;
const BASE_URL = `http://localhost:${API_PORT}`;
const DB_URL = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/bank_db';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('Starting integration test suite...');
  console.log(`API Base URL: ${BASE_URL}`);

  let pgClient;
  try {
    pgClient = new Client({ connectionString: DB_URL });
    await pgClient.connect();
    console.log('Connected to database successfully using primary connection string.');
  } catch (err) {
    console.log(`Primary connection to ${DB_URL} failed (${err.message}). Trying localhost fallback...`);
    try {
      const localDbUrl = DB_URL.replace('@db:', '@localhost:');
      pgClient = new Client({ connectionString: localDbUrl });
      await pgClient.connect();
      console.log('Connected to database successfully using localhost fallback.');
    } catch (err2) {
      console.error('Failed to connect to database for validation checks:', err2.message);
      process.exit(1);
    }
  }

  try {
    // 0. Wait for health check
    console.log('Checking health endpoint...');
    let healthy = false;
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.status === 200) {
          healthy = true;
          break;
        }
      } catch (e) {
        // wait
      }
      await sleep(1000);
    }
    if (!healthy) {
      throw new Error('Health check failed: API server not healthy');
    }
    console.log('Health check passed!');

    // Clean database before starting tests
    console.log('Cleaning database tables for a clean test run...');
    await pgClient.query('TRUNCATE TABLE events, snapshots, account_summaries, transaction_history CASCADE;');
    await pgClient.query('UPDATE projection_status SET last_processed_event_number_global = 0;');

    // 1. Create account
    console.log('\n--- Test 1: Create Account ---');
    const accountId = 'acc-test-12345';
    const ownerName = 'Jane Doe';
    const createRes = await fetch(`${BASE_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        ownerName,
        initialBalance: 0,
        currency: 'USD'
      })
    });
    console.log(`Create account status: ${createRes.status} (Expected: 202)`);
    if (createRes.status !== 202) throw new Error('Create account failed');

    // Verify duplicate creation returns 409
    const createResDup = await fetch(`${BASE_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        ownerName,
        initialBalance: 0,
        currency: 'USD'
      })
    });
    console.log(`Create account duplicate status: ${createResDup.status} (Expected: 409)`);
    if (createResDup.status !== 409) throw new Error('Duplicate create account did not return 409');

    // 2. Deposit money
    console.log('\n--- Test 2: Deposit Money ---');
    const depositTxId = 'tx-dep-1';
    const depRes = await fetch(`${BASE_URL}/api/accounts/${accountId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 100.50,
        description: 'First deposit',
        transactionId: depositTxId
      })
    });
    console.log(`Deposit money status: ${depRes.status} (Expected: 202)`);
    if (depRes.status !== 202) throw new Error('Deposit failed');

    // Check duplicate transaction (idempotency)
    const depResDup = await fetch(`${BASE_URL}/api/accounts/${accountId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 100.50,
        description: 'First deposit',
        transactionId: depositTxId
      })
    });
    console.log(`Duplicate deposit status: ${depResDup.status} (Expected: 202)`);
    if (depResDup.status !== 202) throw new Error('Idempotent deposit did not return 202');

    // 3. Withdraw money
    console.log('\n--- Test 3: Withdraw Money ---');
    const withdrawTxId = 'tx-with-1';
    const withRes = await fetch(`${BASE_URL}/api/accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 50.00,
        description: 'First withdrawal',
        transactionId: withdrawTxId
      })
    });
    console.log(`Withdraw money status: ${withRes.status} (Expected: 202)`);
    if (withRes.status !== 202) throw new Error('Withdrawal failed');

    // Check insufficient funds
    const withResIns = await fetch(`${BASE_URL}/api/accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 200.00,
        description: 'Insufficient funds withdrawal',
        transactionId: 'tx-with-fail'
      })
    });
    console.log(`Insufficient funds withdrawal status: ${withResIns.status} (Expected: 409)`);
    if (withResIns.status !== 409) throw new Error('Insufficient funds did not return 409');

    // 4. Retrieve current state from projection
    console.log('\n--- Test 4: Retrieve State (Read Model) ---');
    await sleep(200); // Wait for async projection
    const getRes = await fetch(`${BASE_URL}/api/accounts/${accountId}`);
    console.log(`Get account status: ${getRes.status} (Expected: 200)`);
    const state = await getRes.json();
    console.log('Account state from projection:', state);
    if (state.balance !== 50.50) throw new Error(`Incorrect balance: ${state.balance} (Expected: 50.50)`);
    if (state.status !== 'OPEN') throw new Error('Incorrect status');

    // 5. Close Account
    console.log('\n--- Test 5: Close Account ---');
    // Try closing with non-zero balance (balance is 50.50)
    const closeResFail = await fetch(`${BASE_URL}/api/accounts/${accountId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Closing test account' })
    });
    console.log(`Close account with balance status: ${closeResFail.status} (Expected: 409)`);
    if (closeResFail.status !== 409) throw new Error('Closing account with balance did not return 409');

    // Withdraw remaining funds (50.50)
    const clearRes = await fetch(`${BASE_URL}/api/accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 50.50,
        description: 'Clear account balance',
        transactionId: 'tx-with-clear'
      })
    });
    if (clearRes.status !== 202) throw new Error('Could not clear account balance');

    // Close account now
    const closeResOk = await fetch(`${BASE_URL}/api/accounts/${accountId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Closing test account' })
    });
    console.log(`Close account status: ${closeResOk.status} (Expected: 202)`);
    if (closeResOk.status !== 202) throw new Error('Closing account failed');

    // Verify deposits to closed account fail
    const depClosedRes = await fetch(`${BASE_URL}/api/accounts/${accountId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 100.00,
        description: 'Deposit to closed account',
        transactionId: 'tx-dep-closed'
      })
    });
    console.log(`Deposit to closed account status: ${depClosedRes.status} (Expected: 409)`);
    if (depClosedRes.status !== 409) throw new Error('Deposit to closed account did not return 409');

    // 6. Time travel query
    console.log('\n--- Test 6: Time Travel Query ---');
    const ttId = 'acc-time-travel-1';
    await fetch(`${BASE_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: ttId, ownerName: 'Time Traveler', initialBalance: 0, currency: 'USD' })
    });

    await sleep(200);
    const t0 = new Date().toISOString();
    await sleep(200);

    // Deposit 100
    await fetch(`${BASE_URL}/api/accounts/${ttId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100.00, description: 'First deposit', transactionId: 'tt-dep-1' })
    });
    await sleep(200);
    const t1 = new Date().toISOString();
    await sleep(200);

    // Deposit 50
    await fetch(`${BASE_URL}/api/accounts/${ttId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50.00, description: 'Second deposit', transactionId: 'tt-dep-2' })
    });
    await sleep(200);

    // Time-travel check between t1 and t2
    const ttRes = await fetch(`${BASE_URL}/api/accounts/${ttId}/balance-at/${encodeURIComponent(t1)}`);
    console.log(`Time travel query status: ${ttRes.status} (Expected: 200)`);
    const ttState = await ttRes.json();
    console.log(`Reconstructed balance at ${t1}:`, ttState.balanceAt);
    if (ttState.balanceAt !== 100.00) throw new Error(`Incorrect time-travel balance: ${ttState.balanceAt} (Expected: 100.00)`);

    // 7. Paginated transactions
    console.log('\n--- Test 7: Paginated Transactions ---');
    const pagId = 'acc-pag-1';
    await fetch(`${BASE_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: pagId, ownerName: 'Pager User', initialBalance: 0, currency: 'USD' })
    });

    // Make 12 deposits
    for (let i = 1; i <= 12; i++) {
      await fetch(`${BASE_URL}/api/accounts/${pagId}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10, description: `Deposit #${i}`, transactionId: `pag-dep-${i}` })
      });
    }

    await sleep(300); // wait for projections
    const pagRes = await fetch(`${BASE_URL}/api/accounts/${pagId}/transactions?page=2&pageSize=10`);
    console.log(`Pagination query status: ${pagRes.status} (Expected: 200)`);
    const pagData = await pagRes.json();
    console.log(`Total count: ${pagData.totalCount} (Expected: 12)`);
    console.log(`Page: ${pagData.currentPage} (Expected: 2)`);
    console.log(`Items count: ${pagData.items.length} (Expected: 2)`);
    if (pagData.totalCount !== 12 || pagData.currentPage !== 2 || pagData.items.length !== 2) {
      throw new Error('Pagination verification failed');
    }

    // 8. Rebuild projections
    console.log('\n--- Test 8: Rebuild Projections ---');
    // Wreak havoc on the summaries and transaction history
    await pgClient.query('DELETE FROM account_summaries;');
    await pgClient.query('DELETE FROM transaction_history;');

    // Verify GET now returns 404 or empty
    const checkRes = await fetch(`${BASE_URL}/api/accounts/${pagId}`);
    console.log(`Account summary after deletion status: ${checkRes.status} (Expected: 404)`);
    if (checkRes.status !== 404) throw new Error('Deletion validation failed');

    // Trigger rebuild
    const rebuildRes = await fetch(`${BASE_URL}/api/projections/rebuild`, { method: 'POST' });
    console.log(`Rebuild trigger status: ${rebuildRes.status} (Expected: 202)`);
    if (rebuildRes.status !== 202) throw new Error('Rebuild command rejected');

    await sleep(500); // Wait for rebuild

    // Re-verify GET returns correct balance
    const checkRes2 = await fetch(`${BASE_URL}/api/accounts/${pagId}`);
    console.log(`Account summary after rebuild status: ${checkRes2.status} (Expected: 200)`);
    const checkState = await checkRes2.json();
    console.log(`Rebuild summary balance: ${checkState.balance} (Expected: 120)`);
    if (checkRes2.status !== 200 || checkState.balance !== 120) {
      throw new Error('Rebuild failed to restore projection data');
    }

    // 9. Snapshotting logic after 50 events
    console.log('\n--- Test 9: Snapshotting Strategy ---');
    const snapId = 'acc-snap-1';
    await fetch(`${BASE_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: snapId, ownerName: 'Snapshot User', initialBalance: 0, currency: 'USD' })
    });

    // Generate 50 more events (50 deposits) to make a total of 51 events
    console.log('Sending 50 deposits to reach 51 total events...');
    for (let i = 1; i <= 50; i++) {
      const depR = await fetch(`${BASE_URL}/api/accounts/${snapId}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1.00, description: `Snap dep #${i}`, transactionId: `snap-dep-${i}` })
      });
      if (depR.status !== 202) throw new Error(`Failed to send deposit #${i}`);
    }

    // Verify snapshot table
    const snapDbRes = await pgClient.query('SELECT * FROM snapshots WHERE aggregate_id = $1', [snapId]);
    console.log(`Snapshot records count in DB: ${snapDbRes.rows.length} (Expected: 1)`);
    if (snapDbRes.rows.length !== 1) throw new Error('Snapshot record was not created or created multiple times');

    const snapshot = snapDbRes.rows[0];
    console.log(`Snapshot last_event_number: ${snapshot.last_event_number} (Expected: 51)`);
    if (snapshot.last_event_number !== 51) throw new Error('Incorrect snapshot last_event_number');
    
    const snapData = snapshot.snapshot_data;
    console.log(`Snapshot balance: ${snapData.balance} (Expected: 50)`);
    if (Number(snapData.balance) !== 50) throw new Error('Snapshot balance mismatch');

    // 10. Projection status check
    console.log('\n--- Test 10: Projection Status and Lag ---');
    const statusRes = await fetch(`${BASE_URL}/api/projections/status`);
    console.log(`Projection status check status: ${statusRes.status} (Expected: 200)`);
    const statusData = await statusRes.json();
    console.log('Projection status response:', JSON.stringify(statusData, null, 2));
    if (!statusData.totalEventsInStore || statusData.projections.length !== 2) {
      throw new Error('Projection status format incorrect');
    }

    console.log('\n=======================================');
    console.log('ALL INTEGRATION TESTS COMPLETED SUCCESSFULLY!');
    console.log('=======================================');
  } catch (error) {
    console.error('\n❌ INTEGRATION TEST FAILED:', error.message);
    process.exit(1);
  } finally {
    if (pgClient) {
      await pgClient.end();
    }
  }
}

runTests();

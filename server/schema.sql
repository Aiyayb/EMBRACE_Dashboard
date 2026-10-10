-- Vocabulary is in GLOSSARY.md. Money is stored in THB; an Account in another
-- currency keeps its native value and the FX rate used beside it.

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    bucket          TEXT NOT NULL CHECK (bucket IN ('investment', 'trading', 'wealth')),
    currency        TEXT NOT NULL DEFAULT 'THB',
    counts_in_total INTEGER NOT NULL DEFAULT 1,      -- 1 = Counted, 0 = Display-only
    allocation      TEXT,                            -- Wealth only: 'saving' or 'emc' (Allocation Group)
    source          TEXT NOT NULL DEFAULT 'manual',  -- manual | family_statement
    note            TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    as_of        TEXT NOT NULL,                      -- YYYY-MM-DD
    value_native REAL NOT NULL,
    fx_rate      REAL NOT NULL DEFAULT 1,            -- THB per 1 unit of the Account's currency
    value_thb    REAL NOT NULL,
    note         TEXT,
    holdings     TEXT,                               -- JSON [{market, stock, qty, value_thb}]; the value is their sum
    entered_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (account_id, as_of)
);

CREATE TABLE IF NOT EXISTS flows (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    on_date    TEXT NOT NULL,                        -- YYYY-MM-DD
    amount_thb REAL NOT NULL,                        -- + deposit, - withdrawal
    kind       TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'opening')),
    note       TEXT,
    entered_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flows_account_date ON flows(account_id, on_date);

CREATE TABLE IF NOT EXISTS benchmarks (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,                             -- VT | SET | BTC
    as_of TEXT NOT NULL,
    value REAL NOT NULL,                             -- price or index level in the Benchmark's own currency
    UNIQUE (name, as_of)
);

-- Best's own Cash Flow for a month (the Expense page).
CREATE TABLE IF NOT EXISTS cashflow_lines (
    id         INTEGER PRIMARY KEY,
    month      TEXT NOT NULL,                        -- YYYY-MM
    section    TEXT NOT NULL CHECK (section IN ('income', 'fixed_cost', 'allocation')),
    line       TEXT NOT NULL,
    amount_thb REAL NOT NULL,
    note       TEXT,
    entered_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (month, section, line)
);

-- All Asset Class: what Best owns and owes beyond the Accounts (house, land, shop stake, debts).
CREATE TABLE IF NOT EXISTS assets (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    asset_class        TEXT NOT NULL,
    value_thb          REAL NOT NULL DEFAULT 0,      -- Best's own estimate
    valued_on          TEXT NOT NULL,
    debt_thb           REAL NOT NULL DEFAULT 0,
    monthly_income_thb REAL,
    monthly_cost_thb   REAL,
    note               TEXT,
    entered_by         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY,
    traded_on   TEXT NOT NULL,
    session     TEXT,
    pair        TEXT,
    side        TEXT,
    setup       TEXT,
    exit_plan   TEXT,
    exit_actual TEXT,
    grade       TEXT,
    outcome     TEXT CHECK (outcome IN ('win', 'loss', 'be')),
    pnl         REAL,                                -- in the journal's own currency (USDT)
    balance     REAL,
    risk        REAL,
    note        TEXT,
    source_row  INTEGER UNIQUE,                      -- row in the journal sheet, so re-import updates
    -- the rest of the journal sheet's columns (War Zone, Entry, Exit); pic_* are chart links
    pic_setup   TEXT,
    poi         TEXT,
    signal      TEXT,
    divergence  TEXT,
    confirm     TEXT,
    fib_time    TEXT,
    fib         TEXT,
    pic_entry   TEXT,
    exit_a      TEXT,                                -- the sheet's "100 of A?" column
    pic_exit    TEXT,
    rr          REAL
);

CREATE TABLE IF NOT EXISTS goals (
    id       INTEGER PRIMARY KEY,
    year     INTEGER NOT NULL,
    name     TEXT NOT NULL,                          -- Stock | Trading | Saving | EMC | OnTheWall
    bucket   TEXT CHECK (bucket IN ('investment', 'trading', 'wealth')),  -- NULL = outside Total Portfolio Value
    goal_thb REAL NOT NULL,
    UNIQUE (year, name)
);

CREATE TABLE IF NOT EXISTS upcoming_items (
    id         INTEGER PRIMARY KEY,
    due_date   TEXT NOT NULL,
    item       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'Bill',
    amount_thb REAL,
    done       INTEGER NOT NULL DEFAULT 0,
    entered_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    track      TEXT,
    status     TEXT,
    progress   REAL NOT NULL DEFAULT 0,              -- 0..1
    next_step  TEXT,
    entered_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advice_notes (
    id         INTEGER PRIMARY KEY,
    noted_on   TEXT NOT NULL,
    topic      TEXT NOT NULL,
    body       TEXT NOT NULL,
    refs       TEXT,                                 -- JSON: the figures the note refers to
    entered_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Shortcuts shown at the bottom of the sidebar (Discord, Telegram). Best sets the address.
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    url        TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

-- Shortcuts shown at the bottom of the sidebar (Discord, Telegram). Best sets the address.
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    url        TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

-- Shortcuts shown at the bottom of the sidebar (Discord, Telegram). Best sets the address.
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    url        TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

-- Every write through the API leaves one row here (ADR 0002).
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    action    TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    tbl       TEXT NOT NULL,
    row_id    INTEGER NOT NULL,
    before    TEXT,
    after     TEXT,
    undone_by INTEGER REFERENCES audit_log(id)
);

-- The shop's monthly profit and loss, typed by Best (ADR 0003). One row per month; `entries` is JSON
-- [{section, line, amount}] with section revenue | cogs | sga | tax. Copied once from the shop app's finance_monthly.
CREATE TABLE IF NOT EXISTS shop_months (
    id         INTEGER PRIMARY KEY,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    entries    TEXT NOT NULL,
    entered_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (year, month)
);

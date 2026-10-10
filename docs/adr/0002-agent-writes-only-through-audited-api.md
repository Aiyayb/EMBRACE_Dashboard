# Maki writes only through the audited API, and the system never moves money

These figures drive real-money decisions, so every change must be attributable and reversible: Maki reads everything but writes data only through a token API that records the Actor and the before and after values, and she does not edit code or the database file directly. The system holds no credential that can trade, transfer or withdraw; the OKX key is read-only and the trading robot is a separate project with its own key, so a leaked dashboard or token cannot lose money.

The token gives attribution, not security: Maki runs on the same PC with shell access and could bypass the API, so the audit log and daily backups are the real protection.

Considered: letting Maki edit files and the database directly (fastest, but wrong numbers would go unnoticed), read-only access for Maki (safest, but she could not record Snapshots or Advice Notes), and letting the dashboard start and stop the trading bot later (rejected, because it puts a trading credential next to an agent with write access).

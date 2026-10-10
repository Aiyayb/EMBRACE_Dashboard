@echo off
rem Starts the dashboard, then open http://127.0.0.1:8770
rem Run it on the main machine only: the database lives on Drive and must not be open on two PCs at once.
rem Set DASHBOARD_PYTHON to use a specific Python (it needs openpyxl to read the family ledger).
cd /d "%~dp0"
if defined DASHBOARD_PYTHON (
  "%DASHBOARD_PYTHON%" server\app.py
) else (
  python server\app.py
)
pause

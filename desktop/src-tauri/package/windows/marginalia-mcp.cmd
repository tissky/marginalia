@echo off
set "MARGINALIA_PY_MODULE=marginalia.mcp_server"
call "%~dp0marginalia.cmd" %*
exit /b %ERRORLEVEL%

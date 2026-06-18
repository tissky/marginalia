@echo off
set "MARGINALIA_PY_MODULE=marginalia.worker"
call "%~dp0marginalia.cmd" %*
exit /b %ERRORLEVEL%

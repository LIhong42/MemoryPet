@echo off
REM 7za.cmd — wrapper that strips -snl flag (avoids symlink extraction failures)
setlocal
set ARGS=
:loop
if "%~1"=="" goto :run
if /i "%~1"=="-snl" ( shift & goto :loop )
if /i "%~1"=="-snld" ( shift & goto :loop )
set ARGS=%ARGS% "%~1"
shift
goto :loop
:run
node "%~dp07za-runner.js" %ARGS%
exit /b %ERRORLEVEL%

@echo off
SETLOCAL ENABLEDELAYEDEXPANSION
REM build.bat - build Ollama extension (supports local and docker builds)
REM Usage: build.bat [docker|local|clean]

SET "ROOT=%~dp0"
PUSHD "%ROOT%"

REM normalize host root (remove trailing backslash) for Docker volume mounts and cp
set "HOSTROOT=%ROOT%"
IF "%HOSTROOT:~-1%"=="\" set "HOSTROOT=%HOSTROOT:~0,-1%"

IF /I "%1"=="" (
  echo No argument specified - auto-selecting build method...
  REM prefer local if npm available, else use docker
  npm --version >nul 2>&1
  IF NOT ERRORLEVEL 1 GOTO local
  docker --version >nul 2>&1
  IF NOT ERRORLEVEL 1 GOTO docker
  echo Neither npm nor docker found. Please install Node.js or Docker.
  GOTO fail
)

IF /I "%1"=="local" GOTO local
IF /I "%1"=="docker" GOTO docker
IF /I "%1"=="clean" GOTO clean
IF /I "%1"=="ollama" GOTO ollama_cmd
IF /I "%1"=="help" GOTO usage

:usage
echo Usage: build.bat [docker^|local^|clean^|ollama]
echo.
echo   (no args) - auto-select: local npm if available, else Docker
echo   local      - build locally (npm ci, compile, package)
echo   docker     - build inside Docker and extract ./dist
echo   clean      - remove node_modules, out, dist
echo   ollama     - manage Ollama Docker service:
echo     start    - start Ollama server  (docker compose up -d ollama)
echo     stop     - stop  Ollama server  (docker compose down)
echo     pull     - pull a model, e.g.: build.bat ollama pull llama3
POPD
ENDLOCAL
EXIT /B 0

:local
echo ---------- Local build (npm via Docker if available) ----------
if not exist package.json (
  echo package.json not found. Are you in the extension folder?
  GOTO fail
)

REM compute host path without trailing backslash for Docker -v
set "HOSTROOT=%ROOT%"
IF "%HOSTROOT:~-1%"=="\" set "HOSTROOT=%HOSTROOT:~0,-1%"

docker --version >nul 2>&1
IF NOT ERRORLEVEL 1 (
  echo Using Docker to run npm commands inside node:20-slim
  echo Installing dependencies - npm ci...
  call docker run --rm -v "%HOSTROOT%:/workspace" -w /workspace node:20-slim sh -c "npm ci --no-audit --no-fund"
  IF ERRORLEVEL 1 GOTO fail
  echo Compiling TypeScript...
  call docker run --rm -v "%HOSTROOT%:/workspace" -w /workspace node:20-slim sh -c "npm run compile"
  IF ERRORLEVEL 1 GOTO fail
  echo Packaging VSIX...
  call docker run --rm -v "%HOSTROOT%:/workspace" -w /workspace node:20-slim sh -c "npm run package"
  IF ERRORLEVEL 1 GOTO fail
  echo Local build (via Docker) finished. Output: %ROOT%dist
  GOTO done
) ELSE (
  echo Docker not found, falling back to local npm
  IF NOT EXIST node_modules (
    echo Installing dependencies - npm ci...
    call npm ci
    IF ERRORLEVEL 1 GOTO fail
  ) ELSE (
    echo Using existing node_modules
  )
  echo Compiling TypeScript...
  call npm run compile
  IF ERRORLEVEL 1 GOTO fail
  echo Packaging VSIX...
  call npm run package
  IF ERRORLEVEL 1 GOTO fail
  echo Local build finished. Output: %ROOT%dist
  GOTO done
)

:docker
echo ---------- Docker build ----------
docker --version >nul 2>&1
IF ERRORLEVEL 1 (
  echo Docker not found. Install Docker or use "local" build.
  GOTO fail
)
if exist "%HOSTROOT%\dist" rd /s /q "%HOSTROOT%\dist"
echo Building docker image and extracting dist...
call docker build -f "%HOSTROOT%\Dockerfile" -t ollama-chat-builder --output "type=local,dest=%HOSTROOT%\dist" "%HOSTROOT%"
IF ERRORLEVEL 1 GOTO fail
if exist "%HOSTROOT%\dist\ami-claw.vsix" (
  echo Docker build succeeded. Artifact: %HOSTROOT%\dist\ami-claw.vsix
  GOTO done
) else (
  echo Build finished but vsix not found in dist\.
  dir "%HOSTROOT%\dist" 2>nul
  GOTO fail
)

:ollama_cmd
docker --version >nul 2>&1
IF ERRORLEVEL 1 (
  echo Docker is required for the ollama command.
  GOTO fail
)
IF /I "%2"=="start" (
  echo Starting Ollama server via docker compose...
  call docker compose up -d ollama
  IF ERRORLEVEL 1 GOTO fail
  echo Ollama is running at http://localhost:11434
  echo Pull a model: build.bat ollama pull llama3
  GOTO done
)
IF /I "%2"=="stop" (
  echo Stopping Ollama server...
  call docker compose down
  IF ERRORLEVEL 1 GOTO fail
  GOTO done
)
IF /I "%2"=="pull" (
  IF "%3"=="" (
    echo Usage: build.bat ollama pull ^<model-name^>
    echo Example: build.bat ollama pull llama3
    GOTO fail
  )
  echo Pulling model %3 from Ollama server...
  call docker compose exec ollama ollama pull %3
  IF ERRORLEVEL 1 GOTO fail
  GOTO done
)
echo Unknown ollama sub-command: %2
echo Valid: start, stop, pull
GOTO fail

:clean
echo Cleaning directories...
if exist node_modules rd /s /q node_modules
if exist out rd /s /q out
if exist dist rd /s /q dist
echo Clean complete.
GOTO done

:fail
echo ERROR: build failed.
POPD
ENDLOCAL
EXIT /B 1

:done
echo Done.
POPD
ENDLOCAL
EXIT /B 0

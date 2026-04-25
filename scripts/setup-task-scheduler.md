# Setup Windows Task Scheduler (1 minute — do this when you wake up)

This makes the AIPickd pipeline run **automatically every 4 hours** without you doing anything. You only have to do this once.

## The easy way (GUI)

1. Press **Windows key** → type **"Programador de tareas"** → open it (it's "Task Scheduler" in English Windows)

2. In the right panel, click **"Crear tarea..."** (Create Task...)

3. **Tab "General"**:
   - Name: `AIPickd-Pipeline`
   - Description: `Generates 1 article every 4 hours and publishes to WordPress`
   - Check: **"Ejecutar con privilegios más altos"** (Run with highest privileges)
   - Check: **"Ejecutar tanto si el usuario inició sesión como si no"** (Run whether user is logged on or not)

4. **Tab "Desencadenadores"** (Triggers) → Click **"Nuevo..."**:
   - Setting: **"Según una programación"** (On a schedule)
   - Select **"Diariamente"** (Daily)
   - Start: today, at `06:00:00 AM`
   - Check: **"Repetir cada"** (Repeat every) → `4 horas` (hours)
   - Duration: `1 día` (1 day)
   - Check: **Habilitado** (Enabled)
   - Click OK

5. **Tab "Acciones"** (Actions) → Click **"Nueva..."**:
   - Action: **"Iniciar un programa"** (Start a program)
   - Programa: `C:\Users\guada\Downloads\Negocio\scripts\run-pipeline.bat`
   - Click OK

6. **Tab "Condiciones"** (Conditions):
   - **UNCHECK** "Iniciar la tarea sólo si el equipo está conectado a la corriente alterna" (uncheck AC power only)
   - Check: "Despertar el equipo para ejecutar esta tarea" (Wake the computer to run)

7. **Tab "Configuración"** (Settings):
   - Check: "Permitir que la tarea se ejecute a petición" (Allow task to run on demand)
   - Check: "Si la tarea ya está en ejecución, se aplica la siguiente regla de ejecución" → select **"No iniciar una nueva instancia"** (Do not start a new instance)

8. Click **OK**. Windows may ask for your password. Enter it.

9. Done. The task will run every 4 hours starting at 6 AM.

## Verify it works

Right-click the task → **"Ejecutar"** (Run). Wait ~1 minute, then check:

```
C:\Users\guada\Downloads\Negocio\logs\
```

You should see a file like `pipeline_2026-04-21_08-00.log`. Open it — you'll see the same output you saw when we tested it manually.

## Run manually anytime

Double-click: `C:\Users\guada\Downloads\Negocio\scripts\run-pipeline.bat`

Or in terminal:
```
node C:\Users\guada\Downloads\Negocio\scripts\run-pipeline.js --gen 1
```

Extra flags:
- `--gen 5` = generate 5 articles in this run
- `--no-gen` = skip generation, just publish any pending drafts
- `--no-pub` = generate but don't publish

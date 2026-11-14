# Cómo correr PolePlanner en tu equipo

**Repositorio:** https://github.com/luismar-ing/NSAC_MissionPlanner

Guía para los integrantes del equipo. Solo hace falta el front end: los datos y las texturas ya vienen en el repositorio (`web/public/data/` y `web/public/textures/`), así que **no necesitas Python ni el pipeline**.

## 1. Instala lo necesario (una sola vez)

| Programa | Versión | Descarga |
|---|---|---|
| Node.js (incluye npm) | 24 LTS (mínimo 22.12) | https://nodejs.org |
| Git | cualquiera reciente | https://git-scm.com |
| Navegador | Chrome, Edge o Firefox actuales (con WebGL) | — |

Comprueba en una terminal (PowerShell, Git Bash, Terminal de macOS o Linux):

```bash
node --version
```

```bash
git --version
```

`node --version` debe mostrar `v24.x` (o `v22.12` o superior).

## 2. Descarga el proyecto (una sola vez)

```bash
git clone https://github.com/luismar-ing/NSAC_MissionPlanner.git
```

```bash
cd NSAC_MissionPlanner
```

## 3. Instala las dependencias

Desde la raíz del repositorio:

```bash
npm --prefix web ci
```

Tarda uno o dos minutos la primera vez.

## 4. Arranca la app

```bash
npm --prefix web run dev
```

Abre en el navegador la dirección que aparece en la terminal, normalmente **http://localhost:5173**. Para detener el servidor, pulsa `Ctrl+C` en la terminal.

## 5. Para recibir los últimos cambios

```bash
git pull
```

```bash
npm --prefix web ci
```

Luego vuelve a ejecutar el paso 4.

## Opcional: versión de producción

Es más rápida y es lo que se verá en la demo:

```bash
npm --prefix web run build
```

```bash
npm --prefix web run preview
```

Abre **http://localhost:4173**.

## Problemas comunes

| Síntoma | Solución |
|---|---|
| `npm` o `node` no se reconoce | Reinstala Node.js y abre una terminal nueva. |
| Error de versión de Node al instalar o arrancar | Actualiza a Node 24 LTS. |
| `npm ci` falla por `package-lock.json` | Asegúrate de estar en la raíz del repo y de haber hecho `git pull`; no uses `npm install` en su lugar. |
| El puerto 5173 está ocupado | Vite usará otro (5174, …); usa la dirección que muestra la terminal. |
| La vista 3D sale en negro o no carga | Activa la aceleración por hardware del navegador o prueba con Chrome/Edge. |

## Qué estás viendo

- **Search:** fija restricciones de energía y comunicación; el calendario de calor marca los planes que las cumplen.
- **Compare (2D):** de 2 a 5 planes lado a lado.
- **Experience (3D):** el viaje del plan elegido. La trayectoria es **ILLUSTRATIVE** (simplificada, no es la de una misión real).
- **Site:** panorama 360° del horizonte y características del sitio.

Más detalle en el [`README.md`](../README.md).

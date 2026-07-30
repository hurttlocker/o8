// FLIP/PIC fluid solver independently implemented from Matthias Müller's public
// "How to write a FLIP water simulator" tutorial (Ten Minute Physics):
// https://matthiasmueller.info/tenMinutePhysics/
//
// The algorithm is adapted to a unit grid (h = 1, one simulation cell per
// rendered ASCII character) with a cursor that acts as a moving obstacle.
// Rendering (sim cell density -> ASCII glyph) lives in the React component;
// this file is pure simulation, no DOM, no React.

export const FLUID_CELL = 0;
export const AIR_CELL = 1;
export const SOLID_CELL = 2;

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export class FlipFluid {
  // Grid (MAC / staggered). h is pinned to 1 — one cell == one ASCII char.
  readonly fNumX: number;
  readonly fNumY: number;
  readonly h = 1.0;
  readonly fInvSpacing = 1.0;
  readonly fNumCells: number;

  readonly u: Float32Array; // horizontal velocity on left cell face
  readonly v: Float32Array; // vertical velocity on bottom cell face
  readonly du: Float32Array; // P2G weight accumulator (u)
  readonly dv: Float32Array; // P2G weight accumulator (v)
  readonly prevU: Float32Array; // grid velocity reference for the FLIP delta
  readonly prevV: Float32Array;
  readonly p: Float32Array; // pressure (kept for completeness / debugging)
  readonly s: Float32Array; // 0 = solid, 1 = fluid-able
  readonly cellType: Int32Array;

  // Particles
  readonly maxParticles: number;
  numParticles = 0;
  readonly particlePos: Float32Array;
  readonly particleVel: Float32Array;
  readonly particleDensity: Float32Array; // per-cell density -> drives ASCII
  particleRestDensity = 0;

  readonly particleRadius: number;
  readonly pInvSpacing: number;
  readonly pNumX: number;
  readonly pNumY: number;
  readonly pNumCells: number;
  readonly numCellParticles: Int32Array;
  readonly firstCellParticle: Int32Array;
  readonly cellParticleIds: Int32Array;

  // Obstacle (the cursor)
  obstacleX = 0;
  obstacleY = 0;
  obstacleRadius = 0;
  obstacleVelX = 0;
  obstacleVelY = 0;
  obstacleActive = false;

  constructor(gridCols: number, gridRows: number, particleRadius: number, maxParticles: number) {
    this.fNumX = gridCols;
    this.fNumY = gridRows;
    this.fNumCells = this.fNumX * this.fNumY;

    this.u = new Float32Array(this.fNumCells);
    this.v = new Float32Array(this.fNumCells);
    this.du = new Float32Array(this.fNumCells);
    this.dv = new Float32Array(this.fNumCells);
    this.prevU = new Float32Array(this.fNumCells);
    this.prevV = new Float32Array(this.fNumCells);
    this.p = new Float32Array(this.fNumCells);
    this.s = new Float32Array(this.fNumCells);
    this.cellType = new Int32Array(this.fNumCells);

    this.maxParticles = maxParticles;
    this.particlePos = new Float32Array(2 * maxParticles);
    this.particleVel = new Float32Array(2 * maxParticles);
    this.particleDensity = new Float32Array(this.fNumCells);

    this.particleRadius = particleRadius;
    this.pInvSpacing = 1.0 / (2.2 * particleRadius);
    this.pNumX = Math.floor(this.fNumX * this.pInvSpacing) + 1;
    this.pNumY = Math.floor(this.fNumY * this.pInvSpacing) + 1;
    this.pNumCells = this.pNumX * this.pNumY;
    this.numCellParticles = new Int32Array(this.pNumCells);
    this.firstCellParticle = new Int32Array(this.pNumCells + 1);
    this.cellParticleIds = new Int32Array(maxParticles);

    this.setupWalls();
  }

  // Solid walls on left, right and floor; open at the top (an open tank).
  private setupWalls(): void {
    const n = this.fNumY;
    for (let i = 0; i < this.fNumX; i++) {
      for (let j = 0; j < this.fNumY; j++) {
        let s = 1.0;
        if (i === 0 || i === this.fNumX - 1 || j === 0) s = 0.0;
        this.s[i * n + j] = s;
      }
    }
  }

  // Hex-pack particles into the bottom `fillHeight` fraction of the tank.
  seedParticles(fillHeight: number): void {
    const r = this.particleRadius;
    const dx = 2.0 * r;
    const dy = (Math.sqrt(3.0) / 2.0) * dx;

    const minX = this.h + r;
    const maxX = (this.fNumX - 1) * this.h - r;
    const minY = this.h + r;
    const maxY = minY + clamp(fillHeight, 0, 1) * ((this.fNumY - 1) * this.h - 2 * this.h);

    let p = 0;
    let j = 0;
    for (let y = minY; y <= maxY && p < this.maxParticles; y += dy, j++) {
      const xOffset = j % 2 === 0 ? 0 : r;
      for (let x = minX + xOffset; x <= maxX && p < this.maxParticles; x += dx) {
        this.particlePos[2 * p] = x;
        this.particlePos[2 * p + 1] = y;
        this.particleVel[2 * p] = 0;
        this.particleVel[2 * p + 1] = 0;
        p++;
      }
    }
    this.numParticles = p;
  }

  private integrateParticles(dt: number, gravity: number): void {
    for (let i = 0; i < this.numParticles; i++) {
      this.particleVel[2 * i + 1] += dt * gravity;
      this.particlePos[2 * i] += this.particleVel[2 * i] * dt;
      this.particlePos[2 * i + 1] += this.particleVel[2 * i + 1] * dt;
    }
  }

  private pushParticlesApart(numIters: number): void {
    const n = this.pNumY;
    this.numCellParticles.fill(0);

    for (let i = 0; i < this.numParticles; i++) {
      const x = this.particlePos[2 * i];
      const y = this.particlePos[2 * i + 1];
      const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
      const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
      this.numCellParticles[xi * n + yi]++;
    }

    let first = 0;
    for (let i = 0; i < this.pNumCells; i++) {
      first += this.numCellParticles[i];
      this.firstCellParticle[i] = first;
    }
    this.firstCellParticle[this.pNumCells] = first;

    for (let i = 0; i < this.numParticles; i++) {
      const x = this.particlePos[2 * i];
      const y = this.particlePos[2 * i + 1];
      const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
      const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
      const cellNr = xi * n + yi;
      this.firstCellParticle[cellNr]--;
      this.cellParticleIds[this.firstCellParticle[cellNr]] = i;
    }

    const minDist = 2.0 * this.particleRadius;
    const minDist2 = minDist * minDist;

    for (let iter = 0; iter < numIters; iter++) {
      for (let i = 0; i < this.numParticles; i++) {
        const px = this.particlePos[2 * i];
        const py = this.particlePos[2 * i + 1];
        const pxi = Math.floor(px * this.pInvSpacing);
        const pyi = Math.floor(py * this.pInvSpacing);
        const x0 = Math.max(pxi - 1, 0);
        const y0 = Math.max(pyi - 1, 0);
        const x1 = Math.min(pxi + 1, this.pNumX - 1);
        const y1 = Math.min(pyi + 1, this.pNumY - 1);

        for (let xi = x0; xi <= x1; xi++) {
          for (let yi = y0; yi <= y1; yi++) {
            const cellNr = xi * n + yi;
            const firstIdx = this.firstCellParticle[cellNr];
            const lastIdx = this.firstCellParticle[cellNr + 1];
            for (let j = firstIdx; j < lastIdx; j++) {
              const id = this.cellParticleIds[j];
              if (id === i) continue;
              const qx = this.particlePos[2 * id];
              const qy = this.particlePos[2 * id + 1];
              let dx = qx - px;
              let dy = qy - py;
              const d2 = dx * dx + dy * dy;
              if (d2 > minDist2 || d2 === 0.0) continue;
              const d = Math.sqrt(d2);
              const s = (0.5 * (minDist - d)) / d;
              dx *= s;
              dy *= s;
              this.particlePos[2 * i] -= dx;
              this.particlePos[2 * i + 1] -= dy;
              this.particlePos[2 * id] += dx;
              this.particlePos[2 * id + 1] += dy;
            }
          }
        }
      }
    }
  }

  private handleParticleCollisions(): void {
    const h = this.h;
    const r = this.particleRadius;
    const minX = h + r;
    const maxX = (this.fNumX - 1) * h - r;
    const minY = h + r;
    const maxY = (this.fNumY - 1) * h - r;

    const or = this.obstacleRadius;
    const minDist = or + r;
    const minDist2 = minDist * minDist;

    for (let i = 0; i < this.numParticles; i++) {
      let x = this.particlePos[2 * i];
      let y = this.particlePos[2 * i + 1];

      if (this.obstacleActive && or > 0) {
        const dx = x - this.obstacleX;
        const dy = y - this.obstacleY;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDist2) {
          this.particleVel[2 * i] = this.obstacleVelX;
          this.particleVel[2 * i + 1] = this.obstacleVelY;
        }
      }

      if (x < minX) {
        x = minX;
        this.particleVel[2 * i] = 0;
      }
      if (x > maxX) {
        x = maxX;
        this.particleVel[2 * i] = 0;
      }
      if (y < minY) {
        y = minY;
        this.particleVel[2 * i + 1] = 0;
      }
      if (y > maxY) {
        y = maxY;
        this.particleVel[2 * i + 1] = 0;
      }
      this.particlePos[2 * i] = x;
      this.particlePos[2 * i + 1] = y;
    }
  }

  private updateParticleDensity(): void {
    const n = this.fNumY;
    const h = this.h;
    const h1 = this.fInvSpacing;
    const h2 = 0.5 * h;
    const d = this.particleDensity;
    d.fill(0.0);

    for (let i = 0; i < this.numParticles; i++) {
      let x = this.particlePos[2 * i];
      let y = this.particlePos[2 * i + 1];
      x = clamp(x, h, (this.fNumX - 1) * h);
      y = clamp(y, h, (this.fNumY - 1) * h);

      const x0 = Math.floor((x - h2) * h1);
      const tx = (x - h2 - x0 * h) * h1;
      const x1 = Math.min(x0 + 1, this.fNumX - 2);
      const y0 = Math.floor((y - h2) * h1);
      const ty = (y - h2 - y0 * h) * h1;
      const y1 = Math.min(y0 + 1, this.fNumY - 2);
      const sx = 1.0 - tx;
      const sy = 1.0 - ty;

      if (x0 < this.fNumX && y0 < this.fNumY) d[x0 * n + y0] += sx * sy;
      if (x1 < this.fNumX && y0 < this.fNumY) d[x1 * n + y0] += tx * sy;
      if (x1 < this.fNumX && y1 < this.fNumY) d[x1 * n + y1] += tx * ty;
      if (x0 < this.fNumX && y1 < this.fNumY) d[x0 * n + y1] += sx * ty;
    }

    if (this.particleRestDensity === 0.0) {
      let sum = 0.0;
      let numFluidCells = 0;
      for (let i = 0; i < this.fNumCells; i++) {
        if (this.cellType[i] === FLUID_CELL) {
          sum += d[i];
          numFluidCells++;
        }
      }
      if (numFluidCells > 0) this.particleRestDensity = sum / numFluidCells;
    }
  }

  private transferVelocities(toGrid: boolean, flipRatio: number): void {
    const n = this.fNumY;
    const h = this.h;
    const h1 = this.fInvSpacing;
    const h2 = 0.5 * h;

    if (toGrid) {
      this.prevU.set(this.u);
      this.prevV.set(this.v);
      this.du.fill(0.0);
      this.dv.fill(0.0);
      this.u.fill(0.0);
      this.v.fill(0.0);

      for (let i = 0; i < this.fNumCells; i++) {
        this.cellType[i] = this.s[i] === 0.0 ? SOLID_CELL : AIR_CELL;
      }

      for (let i = 0; i < this.numParticles; i++) {
        const x = this.particlePos[2 * i];
        const y = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * h1), 0, this.fNumX - 1);
        const yi = clamp(Math.floor(y * h1), 0, this.fNumY - 1);
        const cellNr = xi * n + yi;
        if (this.cellType[cellNr] === AIR_CELL) this.cellType[cellNr] = FLUID_CELL;
      }
    }

    for (let component = 0; component < 2; component++) {
      const dx = component === 0 ? 0.0 : h2;
      const dy = component === 0 ? h2 : 0.0;
      const f = component === 0 ? this.u : this.v;
      const prevF = component === 0 ? this.prevU : this.prevV;
      const d = component === 0 ? this.du : this.dv;

      for (let i = 0; i < this.numParticles; i++) {
        let x = this.particlePos[2 * i];
        let y = this.particlePos[2 * i + 1];
        x = clamp(x, h, (this.fNumX - 1) * h);
        y = clamp(y, h, (this.fNumY - 1) * h);

        const x0 = Math.min(Math.floor((x - dx) * h1), this.fNumX - 2);
        const tx = (x - dx - x0 * h) * h1;
        const x1 = Math.min(x0 + 1, this.fNumX - 2);
        const y0 = Math.min(Math.floor((y - dy) * h1), this.fNumY - 2);
        const ty = (y - dy - y0 * h) * h1;
        const y1 = Math.min(y0 + 1, this.fNumY - 2);

        const sx = 1.0 - tx;
        const sy = 1.0 - ty;
        const d0 = sx * sy;
        const d1 = tx * sy;
        const d2 = tx * ty;
        const d3 = sx * ty;
        const nr0 = x0 * n + y0;
        const nr1 = x1 * n + y0;
        const nr2 = x1 * n + y1;
        const nr3 = x0 * n + y1;

        if (toGrid) {
          const pv = this.particleVel[2 * i + component];
          f[nr0] += pv * d0;
          d[nr0] += d0;
          f[nr1] += pv * d1;
          d[nr1] += d1;
          f[nr2] += pv * d2;
          d[nr2] += d2;
          f[nr3] += pv * d3;
          d[nr3] += d3;
        } else {
          const offset = component === 0 ? n : 1;
          const valid0 = this.cellType[nr0] !== AIR_CELL || this.cellType[nr0 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid1 = this.cellType[nr1] !== AIR_CELL || this.cellType[nr1 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid2 = this.cellType[nr2] !== AIR_CELL || this.cellType[nr2 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid3 = this.cellType[nr3] !== AIR_CELL || this.cellType[nr3 - offset] !== AIR_CELL ? 1.0 : 0.0;

          const vCur = this.particleVel[2 * i + component];
          const dSum = valid0 * d0 + valid1 * d1 + valid2 * d2 + valid3 * d3;

          if (dSum > 0.0) {
            const picV =
              (valid0 * d0 * f[nr0] + valid1 * d1 * f[nr1] + valid2 * d2 * f[nr2] + valid3 * d3 * f[nr3]) / dSum;
            const corr =
              (valid0 * d0 * (f[nr0] - prevF[nr0]) +
                valid1 * d1 * (f[nr1] - prevF[nr1]) +
                valid2 * d2 * (f[nr2] - prevF[nr2]) +
                valid3 * d3 * (f[nr3] - prevF[nr3])) /
              dSum;
            const flipV = vCur + corr;
            this.particleVel[2 * i + component] = (1.0 - flipRatio) * picV + flipRatio * flipV;
          }
        }
      }

      if (toGrid) {
        for (let i = 0; i < f.length; i++) {
          if (d[i] > 0.0) f[i] /= d[i];
        }
        // restore solid-cell faces to their pre-transfer values
        for (let i = 0; i < this.fNumX; i++) {
          for (let j = 0; j < this.fNumY; j++) {
            const solid = this.cellType[i * n + j] === SOLID_CELL;
            if (solid || (i > 0 && this.cellType[(i - 1) * n + j] === SOLID_CELL)) this.u[i * n + j] = this.prevU[i * n + j];
            if (solid || (j > 0 && this.cellType[i * n + j - 1] === SOLID_CELL)) this.v[i * n + j] = this.prevV[i * n + j];
          }
        }
      }
    }
  }

  private solveIncompressibility(
    numIters: number,
    dt: number,
    overRelaxation: number,
    compensateDrift: boolean,
  ): void {
    const n = this.fNumY;
    this.p.fill(0.0);
    this.prevU.set(this.u);
    this.prevV.set(this.v);

    for (let iter = 0; iter < numIters; iter++) {
      for (let i = 1; i < this.fNumX - 1; i++) {
        for (let j = 1; j < this.fNumY - 1; j++) {
          if (this.cellType[i * n + j] !== FLUID_CELL) continue;

          const center = i * n + j;
          const left = (i - 1) * n + j;
          const right = (i + 1) * n + j;
          const bottom = i * n + j - 1;
          const top = i * n + j + 1;

          const sx0 = this.s[left];
          const sx1 = this.s[right];
          const sy0 = this.s[bottom];
          const sy1 = this.s[top];
          const s = sx0 + sx1 + sy0 + sy1;
          if (s === 0.0) continue;

          let div = this.u[right] - this.u[center] + this.v[top] - this.v[center];

          if (this.particleRestDensity > 0.0 && compensateDrift) {
            const k = 1.0;
            const compression = this.particleDensity[center] - this.particleRestDensity;
            if (compression > 0.0) div = div - k * compression;
          }

          let p = -div / s;
          p *= overRelaxation;

          this.u[center] -= sx0 * p;
          this.u[right] += sx1 * p;
          this.v[center] -= sy0 * p;
          this.v[top] += sy1 * p;
        }
      }
    }
  }

  // Stamp the cursor as a moving solid obstacle into the grid each frame.
  setObstacle(x: number, y: number, vx: number, vy: number, radius: number, active: boolean): void {
    this.obstacleActive = active;
    this.obstacleX = x;
    this.obstacleY = y;
    this.obstacleRadius = radius;
    this.obstacleVelX = active ? vx : 0;
    this.obstacleVelY = active ? vy : 0;

    if (!active || radius <= 0) return;

    const n = this.fNumY;
    const r = radius;
    for (let i = 1; i < this.fNumX - 2; i++) {
      for (let j = 1; j < this.fNumY - 2; j++) {
        const dx = (i + 0.5) * this.h - x;
        const dy = (j + 0.5) * this.h - y;
        if (dx * dx + dy * dy < r * r) {
          this.s[i * n + j] = 0.0;
          this.u[i * n + j] = vx;
          this.u[(i + 1) * n + j] = vx;
          this.v[i * n + j] = vy;
          this.v[i * n + j + 1] = vy;
        }
      }
    }
  }

  // Clear any obstacle solids stamped last frame (interior cells back to fluid).
  clearObstacleSolids(): void {
    const n = this.fNumY;
    for (let i = 1; i < this.fNumX - 1; i++) {
      for (let j = 1; j < this.fNumY - 1; j++) {
        this.s[i * n + j] = 1.0;
      }
    }
  }

  simulate(
    dt: number,
    gravity: number,
    flipRatio: number,
    numPressureIters: number,
    numParticleIters: number,
    overRelaxation: number,
    compensateDrift: boolean,
    separateParticles: boolean,
  ): void {
    this.integrateParticles(dt, gravity);
    if (separateParticles) this.pushParticlesApart(numParticleIters);
    this.handleParticleCollisions();
    this.transferVelocities(true, flipRatio);
    this.updateParticleDensity();
    this.solveIncompressibility(numPressureIters, dt, overRelaxation, compensateDrift);
    this.transferVelocities(false, flipRatio);
  }
}

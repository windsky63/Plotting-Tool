/**
 * 矢量数据空间索引 (网格索引)
 * 用于快速查找点击位置附近的矢量元素
 */
export class VectorSpatialIndex {
  constructor(vectors, width, height, cellSize = 50) {
    this.vectors = vectors;
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.grid = new Map(); // key: "x,y", value: [vectorIndex, ...]
    
    this.buildIndex();
  }

  /**
   * 构建网格索引
   */
  buildIndex() {
    if (!this.vectors) return;

    this.vectors.forEach((vec, index) => {
      if (!Array.isArray(vec) || vec.length < 5) return;
      
      const [type, x1, y1, x2, y2] = vec;
      
      // 计算线段覆盖的网格单元
      // 简单起见，只索引线段的两个端点和中点，对于长线段可能不够精确，但性能好
      // 如果需要更精确，可以使用 Bresenham 算法覆盖所有经过的格子
      
      const points = [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
      ];

      const visitedKeys = new Set();

      points.forEach(p => {
        const key = this.getCellKey(p.x, p.y);
        if (!visitedKeys.has(key)) {
          visitedKeys.add(key);
          if (!this.grid.has(key)) {
            this.grid.set(key, []);
          }
          this.grid.get(key).push(index);
        }
      });
    });
    
    console.log(`📦 空间索引构建完成，网格数量: ${this.grid.size}`);
  }

  getCellKey(x, y) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  /**
   * 查找点附近的矢量元素
   * @param {number} x - 坐标 x
   * @param {number} y - 坐标 y
   * @param {number} threshold - 距离阈值
   * @returns {Array} - 附近的矢量元素索引列表
   */
  findNearby(x, y, threshold = 5) {
    const key = this.getCellKey(x, y);
    const candidateIndices = this.grid.get(key);
    
    if (!candidateIndices) return [];

    const nearbyIndices = [];
    
    // 检查候选元素到点的距离
    candidateIndices.forEach(index => {
      const vec = this.vectors[index];
      const [type, x1, y1, x2, y2] = vec;
      
      const dist = this.pointToLineDistance(x, y, x1, y1, x2, y2);
      if (dist <= threshold) {
        nearbyIndices.push(index);
      }
    });

    return nearbyIndices;
  }

  /**
   * 计算点到线段的最短距离
   */
  pointToLineDistance(px, py, x1, y1, x2, y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    
    let param = -1;
    if (len_sq !== 0) // avoid zero division
      param = dot / len_sq;

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    
    return Math.sqrt(dx * dx + dy * dy);
  }
}


/**
 * 矢量测试按钮组件
 * 当前激活：三角形识别（三线段闭合路径）
 *
 * [已保存] 弯头检测逻辑 → detectElbows()
 *   类型1：5-6个小路径，每个4线段，总长度4.5-5.5，排列在一起
 *   类型2：5-6个小路径，每个4线段，总长度6.0-6.5，排列在一起
 *   规则3：组成弯头的路径ID必须连续
 *   规则4：相邻路径必须共享一条边（两个顶点重合）
 *   规则5：单路径必须有2长2短边特征
 *
 * [激活] 三角形识别逻辑 → detectTriangles()
 *   规则1：单个路径恰好包含 3 条线段
 *   规则2：三条线段首尾相连形成闭合环（容差 0.5）
 */

import React, { useState } from 'react';
import { Button, message } from 'antd';
import { HighlightOutlined } from '@ant-design/icons';

// ─────────────────────────────────────────────────────────────
// 【已保存】弯头检测逻辑（暂不激活）
// ─────────────────────────────────────────────────────────────
function detectElbows(pageVectors) {
  let totalMatched = 0;
  const matchedElbows = [];

  Object.entries(pageVectors).forEach(([pageNum, vectors]) => {
    if (!vectors || vectors.length === 0) return;

    console.log(`\n📄 [弯头] 检查第 ${pageNum} 页 (${vectors.length} 个矢量)`);

    const pathGroups = {};
    vectors.forEach(vector => {
      const pathId = vector[7];
      if (pathId !== undefined && pathId !== null) {
        if (!pathGroups[pathId]) pathGroups[pathId] = [];
        pathGroups[pathId].push(vector);
      }
    });

    const candidates = [];
    Object.entries(pathGroups).forEach(([pathId, pathVectors]) => {
      if (pathVectors.length !== 4) return;

      const lengths = pathVectors.map(v => {
        const dx = v[3] - v[1], dy = v[4] - v[2];
        return Math.sqrt(dx * dx + dy * dy);
      });
      const totalLength = lengths.reduce((a, b) => a + b, 0);

      let pathType = null;
      if (totalLength >= 4.5 && totalLength <= 5.5) pathType = 'type1';
      else if (totalLength >= 6.0 && totalLength <= 6.5) pathType = 'type2';

      const sortedLengths = [...lengths].sort((a, b) => b - a);
      if (sortedLengths[0] < 1.4) pathType = null;
      if ((sortedLengths[0] + sortedLengths[1]) / totalLength < 0.5) pathType = null;

      if (!pathType) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pathVectors.forEach(v => {
        minX = Math.min(minX, v[1], v[3]);
        minY = Math.min(minY, v[2], v[4]);
        maxX = Math.max(maxX, v[1], v[3]);
        maxY = Math.max(maxY, v[2], v[4]);
      });

      candidates.push({
        pathId, pathVectors, segmentCount: 4, totalLength, pathType,
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        bbox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
      });
    });

    const used = new Set();
    candidates.forEach((candidate, i) => {
      if (used.has(i)) return;

      const cluster = [candidate];
      const clusterIndices = [i];

      candidates.forEach((other, j) => {
        if (i === j || used.has(j)) return;
        const dist = Math.sqrt(
          Math.pow(candidate.center.x - other.center.x, 2) +
          Math.pow(candidate.center.y - other.center.y, 2)
        );
        if (dist < 10) { cluster.push(other); clusterIndices.push(j); }
      });

      if (cluster.length < 5 || cluster.length > 6) return;

      const ids = cluster.map(c => parseInt(c.pathId)).sort((a, b) => a - b);
      for (let k = 0; k < ids.length - 1; k++) {
        if (ids[k + 1] - ids[k] !== 1) return;
      }

      const sortedCluster = [...cluster].sort((a, b) => parseInt(a.pathId) - parseInt(b.pathId));
      for (let k = 0; k < sortedCluster.length - 1; k++) {
        const cur = sortedCluster[k], nxt = sortedCluster[k + 1];
        const curPts = cur.pathVectors.flatMap(v => [{ x: v[1], y: v[2] }, { x: v[3], y: v[4] }]);
        const nxtPts = nxt.pathVectors.flatMap(v => [{ x: v[1], y: v[2] }, { x: v[3], y: v[4] }]);
        let shared = 0;
        for (const p1 of curPts)
          for (const p2 of nxtPts)
            if (Math.abs(p1.x - p2.x) < 0.1 && Math.abs(p1.y - p2.y) < 0.1) shared++;
        if (shared < 2) return;
      }

      totalMatched++;
      clusterIndices.forEach(idx => used.add(idx));

      let eMinX = Infinity, eMinY = Infinity, eMaxX = -Infinity, eMaxY = -Infinity;
      const allPathIds = [];
      const pathTypes = { type1: 0, type2: 0 };
      cluster.forEach(c => {
        eMinX = Math.min(eMinX, c.bbox.minX); eMinY = Math.min(eMinY, c.bbox.minY);
        eMaxX = Math.max(eMaxX, c.bbox.maxX); eMaxY = Math.max(eMaxY, c.bbox.maxY);
        allPathIds.push(c.pathId);
        pathTypes[c.pathType]++;
      });

      let elbowType = 'mixed';
      if (pathTypes.type1 > 0 && pathTypes.type2 === 0) elbowType = 'type1';
      else if (pathTypes.type2 > 0 && pathTypes.type1 === 0) elbowType = 'type2';

      matchedElbows.push({
        page: pageNum, pathIds: allPathIds, pathCount: cluster.length,
        elbowType, pathTypes,
        center: { x: (eMinX + eMaxX) / 2, y: (eMinY + eMaxY) / 2 },
        bbox: { minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY },
        paths: cluster
      });

      const typeLabel = elbowType === 'type1' ? '类型1(4.5-5.5)' :
                        elbowType === 'type2' ? '类型2(6.0-6.5)' :
                        `混合(类型1:${pathTypes.type1}, 类型2:${pathTypes.type2})`;
      console.log(`✅ 匹配弯头 #${totalMatched}: ${typeLabel}`);
      console.log(`   包含路径: ${allPathIds.join(', ')}, 数量: ${cluster.length}`);
    });
  });

  return { totalMatched, matchedElbows };
}

// ─────────────────────────────────────────────────────────────
// 【激活】三角形识别逻辑
// 三角形 = 单个 pathId 下恰好 3 条线段，且首尾相连形成闭合环
// ─────────────────────────────────────────────────────────────
function detectTriangles(pageVectors) {
  const CLOSE_THRESHOLD = 0.5; // 闭合容差（坐标单位）
  let totalMatched = 0;
  const matchedTriangles = [];

  Object.entries(pageVectors).forEach(([pageNum, vectors]) => {
    if (!vectors || vectors.length === 0) return;

    console.log(`\n📄 [三角形] 检查第 ${pageNum} 页 (${vectors.length} 个矢量)`);

    // 按 pathId 分组
    const pathGroups = {};
    vectors.forEach(vector => {
      const pathId = vector[7];
      if (pathId !== undefined && pathId !== null) {
        if (!pathGroups[pathId]) pathGroups[pathId] = [];
        pathGroups[pathId].push(vector);
      }
    });

    Object.entries(pathGroups).forEach(([pathId, pathVectors]) => {
      // 规则1：恰好 3 条线段
      if (pathVectors.length !== 3) return;

      // 提取 3 条线段的端点 [[x1,y1,x2,y2], ...]
      const segs = pathVectors.map(v => ({
        x1: v[1], y1: v[2], x2: v[3], y2: v[4]
      }));

      // 规则2：三条线段首尾相连形成闭合环
      // 尝试对三条线段做拓扑排序，找到 A→B→C→A 的闭合链
      const isClose = (ax, ay, bx, by) =>
        Math.abs(ax - bx) < CLOSE_THRESHOLD && Math.abs(ay - by) < CLOSE_THRESHOLD;

      // 每条线段有两个端点，各可以正向/反向，尝试所有组合
      // 用深度优先搜索：从第0条线段出发，找一条覆盖全部3段的闭合路径
      let isTriangle = false;
      let orderedSegs = null; // 排序后的有向线段 [{x1,y1,x2,y2}, ...]

      // 生成线段的两种方向
      const both = seg => [
        { x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 },
        { x1: seg.x2, y1: seg.y2, x2: seg.x1, y2: seg.y1 }
      ];

      // 穷举：对 segs[0] 的两个方向，尝试从它开始连接剩余两条
      for (const startSeg of both(segs[0])) {
        if (isTriangle) break;
        const remaining = [segs[1], segs[2]];

        for (let i = 0; i < remaining.length; i++) {
          if (isTriangle) break;
          const midCandidates = both(remaining[i]);
          const thirdIdx = i === 0 ? 1 : 0;

          for (const midSeg of midCandidates) {
            if (isTriangle) break;
            // startSeg.end 必须与 midSeg.start 接近
            if (!isClose(startSeg.x2, startSeg.y2, midSeg.x1, midSeg.y1)) continue;

            const thirdCandidates = both(remaining[thirdIdx]);
            for (const endSeg of thirdCandidates) {
              // midSeg.end 接 endSeg.start，endSeg.end 接 startSeg.start（闭合）
              if (
                isClose(midSeg.x2, midSeg.y2, endSeg.x1, endSeg.y1) &&
                isClose(endSeg.x2, endSeg.y2, startSeg.x1, startSeg.y1)
              ) {
                isTriangle = true;
                orderedSegs = [startSeg, midSeg, endSeg];
                break;
              }
            }
          }
        }
      }

      if (!isTriangle) return;

      // 计算三角形包围盒与面积（叉积/海伦公式）
      const pts = [
        { x: orderedSegs[0].x1, y: orderedSegs[0].y1 },
        { x: orderedSegs[1].x1, y: orderedSegs[1].y1 },
        { x: orderedSegs[2].x1, y: orderedSegs[2].y1 },
      ];
      const area = Math.abs(
        (pts[1].x - pts[0].x) * (pts[2].y - pts[0].y) -
        (pts[2].x - pts[0].x) * (pts[1].y - pts[0].y)
      ) / 2;

      const allX = pts.map(p => p.x);
      const allY = pts.map(p => p.y);
      const minX = Math.min(...allX), maxX = Math.max(...allX);
      const minY = Math.min(...allY), maxY = Math.max(...allY);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // 计算三条边长度（边i = pts[i] → pts[(i+1)%3]）
      const sideLengths = [0, 1, 2].map(i => {
        const a = pts[i], b = pts[(i + 1) % 3];
        const dx = b.x - a.x, dy = b.y - a.y;
        return Math.sqrt(dx * dx + dy * dy);
      });

      // ── 起点/末端判定 ──────────────────────────────────────────
      // 原理：最长边为"底边"，底边对面的顶点为"尖端（起点）"
      //       底边中点为"末端"，尖端→末端向量的反方向即箭头指向
      //
      //   底边索引 i 对应的边是 pts[i]→pts[(i+1)%3]
      //   对面顶点索引 = (i+2)%3
      const baseIdx = sideLengths.indexOf(Math.max(...sideLengths)); // 最长边索引
      const apexIdx = (baseIdx + 2) % 3;                             // 尖端顶点索引
      const baseA   = pts[baseIdx];
      const baseB   = pts[(baseIdx + 1) % 3];
      const apex    = pts[apexIdx];                                   // 尖端（起点）
      const baseMid = {                                               // 底边中点（末端）
        x: (baseA.x + baseB.x) / 2,
        y: (baseA.y + baseB.y) / 2,
      };

      // 方向向量：从底边中点指向尖端（即箭头方向）
      const dirVec = { x: apex.x - baseMid.x, y: apex.y - baseMid.y };
      const dirLen = Math.sqrt(dirVec.x * dirVec.x + dirVec.y * dirVec.y) || 1;
      const dirNorm = { x: dirVec.x / dirLen, y: dirVec.y / dirLen }; // 单位方向向量
      // 方位角（与X轴正方向夹角，度）
      const angleDeg = Math.atan2(dirNorm.y, dirNorm.x) * 180 / Math.PI;
      // ─────────────────────────────────────────────────────────

      totalMatched++;

      matchedTriangles.push({
        page: pageNum,
        pathId,
        pathVectors,
        orderedSegs,
        vertices: pts,
        sideLengths,
        area,
        center: { x: centerX, y: centerY },
        bbox: { minX, minY, maxX, maxY },
        // 起点/末端
        apex,       // 尖端（起点）：最长边对面的顶点
        baseMid,    // 末端：最长边中点
        baseA,      // 底边端点A
        baseB,      // 底边端点B
        baseLength: sideLengths[baseIdx],
        direction: dirNorm,   // 单位方向向量（baseMid → apex）
        angleDeg,             // 方位角（度）
      });

      console.log(`✅ 三角形 #${totalMatched}  pathId=${pathId}`);
      console.log(`   顶点: (${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}) `
        + `(${pts[1].x.toFixed(2)},${pts[1].y.toFixed(2)}) `
        + `(${pts[2].x.toFixed(2)},${pts[2].y.toFixed(2)})`);
      console.log(`   边长: ${sideLengths.map(l => l.toFixed(3)).join(' / ')}  底边长: ${sideLengths[baseIdx].toFixed(3)}`);
      console.log(`   面积: ${area.toFixed(4)}  中心: (${centerX.toFixed(2)}, ${centerY.toFixed(2)})`);
      console.log(`   🔺 尖端(起点): (${apex.x.toFixed(2)}, ${apex.y.toFixed(2)})`);
      console.log(`   🔻 末端(底边中点): (${baseMid.x.toFixed(2)}, ${baseMid.y.toFixed(2)})`);
      console.log(`   ➡️  方向向量: (${dirNorm.x.toFixed(3)}, ${dirNorm.y.toFixed(3)})  方位角: ${angleDeg.toFixed(1)}°`);
    });
  });

  return { totalMatched, matchedTriangles };
}

// ─────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────
export const VectorTestButton = ({ pageVectors, currentPage }) => {
  const [highlightActive, setHighlightActive] = useState(false);

  const handleVectorTest = () => {
    if (!pageVectors || Object.keys(pageVectors).length === 0) {
      message.warning('请先加载PDF并提取矢量数据');
      return;
    }

    window.__highlightedPaths__ = null;
    window.dispatchEvent(new Event('vectorTestUpdate'));

    console.log('🔍 开始矢量测试 - 规则：三角形识别（三线段闭合路径）');
    console.log(`   闭合容差: 0.5 坐标单位`);

    const { totalMatched, matchedTriangles } = detectTriangles(pageVectors);

    if (totalMatched > 0) {
      console.log(`\n🎯 总共识别到 ${totalMatched} 个三角形`);
      console.table(matchedTriangles.map((t, idx) => ({
        序号: idx + 1,
        页码: t.page,
        pathId: t.pathId,
        边长1: t.sideLengths[0].toFixed(3),
        边长2: t.sideLengths[1].toFixed(3),
        底边长: t.baseLength.toFixed(3),
        面积: t.area.toFixed(4),
        尖端X: t.apex.x.toFixed(2),
        尖端Y: t.apex.y.toFixed(2),
        末端X: t.baseMid.x.toFixed(2),
        末端Y: t.baseMid.y.toFixed(2),
        方位角: t.angleDeg.toFixed(1) + '°',
        方向向量: `(${t.direction.x.toFixed(2)},${t.direction.y.toFixed(2)})`,
      })));

      const allMatchedPaths = matchedTriangles.map((t, i) => ({
        page: t.page,
        pathId: t.pathId,
        segmentCount: 3,
        isTriangle: true,
        triangleId: i + 1,
        // 起点/末端信息，供高亮渲染层使用
        apex: t.apex,
        baseMid: t.baseMid,
        baseA: t.baseA,
        baseB: t.baseB,
        direction: t.direction,
        angleDeg: t.angleDeg,
      }));

      window.__highlightedPaths__ = allMatchedPaths;
      setHighlightActive(true);

      const highlightedIds = allMatchedPaths.map(p => p.pathId);
      console.log(`\n🎨 高亮路径ID: ${highlightedIds.join(', ')}（共 ${highlightedIds.length} 个）`);
      message.success(`找到 ${totalMatched} 个三角形，已高亮显示（紫色）`);
    } else {
      console.log('❌ 未找到三线段闭合路径（三角形）');
      window.__highlightedPaths__ = null;
      setHighlightActive(false);
      message.info('未找到三角形（三线段闭合路径）');
    }

    window.dispatchEvent(new Event('vectorTestUpdate'));
  };

  const handleClearHighlight = () => {
    window.__highlightedPaths__ = null;
    setHighlightActive(false);
    window.dispatchEvent(new Event('vectorTestUpdate'));
    message.info('已清除高亮');
  };

  return (
    <Button
      type={highlightActive ? 'primary' : 'default'}
      icon={<HighlightOutlined />}
      onClick={highlightActive ? handleClearHighlight : handleVectorTest}
      style={{
        backgroundColor: highlightActive ? '#9333ea' : undefined,
        borderColor: highlightActive ? '#9333ea' : undefined,
        color: highlightActive ? '#fff' : undefined
      }}
    >
      {highlightActive ? '清除高亮' : '矢量测试'}
    </Button>
  );
};

export default VectorTestButton;

import {
  getNextPipeSegmentLabel,
  indexToLetterSequence,
  letterSequenceToIndex
} from '../pipeSegmentUtils';

describe('pipeSegmentUtils', () => {
  test('纯数字起始值按数字递增', () => {
    expect(getNextPipeSegmentLabel('1', 0)).toBe('1');
    expect(getNextPipeSegmentLabel('1', 1)).toBe('2');
    expect(getNextPipeSegmentLabel('12', 3)).toBe('15');
  });

  test('带数字前后缀时只递增数字部分', () => {
    expect(getNextPipeSegmentLabel('PS1A', 0)).toBe('PS1A');
    expect(getNextPipeSegmentLabel('PS1A', 1)).toBe('PS2A');
    expect(getNextPipeSegmentLabel('SEG09-X', 2)).toBe('SEG11-X');
  });

  test('单字母序列遵循 Excel 风格递增', () => {
    expect(getNextPipeSegmentLabel('A', 0)).toBe('A');
    expect(getNextPipeSegmentLabel('A', 25)).toBe('Z');
    expect(getNextPipeSegmentLabel('A', 26)).toBe('AA');
    expect(getNextPipeSegmentLabel('Z', 1)).toBe('AA');
  });

  test('双字母及更长字母序列继续按 Excel 风格递增', () => {
    expect(getNextPipeSegmentLabel('AA', 0)).toBe('AA');
    expect(getNextPipeSegmentLabel('AA', 1)).toBe('AB');
    expect(getNextPipeSegmentLabel('AZ', 1)).toBe('BA');
    expect(getNextPipeSegmentLabel('ZZ', 1)).toBe('AAA');
  });

  test('非纯字母且不含数字时保留原值并追加序号', () => {
    expect(getNextPipeSegmentLabel('管段', 0)).toBe('管段');
    expect(getNextPipeSegmentLabel('管段', 1)).toBe('管段2');
    expect(getNextPipeSegmentLabel('支线', 4)).toBe('支线5');
  });

  test('空起始值默认回退到 A', () => {
    expect(getNextPipeSegmentLabel('', 0)).toBe('A');
    expect(getNextPipeSegmentLabel(null, 1)).toBe('B');
  });

  test('字母序列与索引转换互为逆操作', () => {
    expect(letterSequenceToIndex('A')).toBe(0);
    expect(letterSequenceToIndex('Z')).toBe(25);
    expect(letterSequenceToIndex('AA')).toBe(26);
    expect(letterSequenceToIndex('ZZ')).toBe(701);

    expect(indexToLetterSequence(0)).toBe('A');
    expect(indexToLetterSequence(25)).toBe('Z');
    expect(indexToLetterSequence(26)).toBe('AA');
    expect(indexToLetterSequence(702)).toBe('AAA');
  });
});

/** 用于确定性测试和模拟组合的最小时钟端口。 */
export interface Clock {
  nowIso(): string;
}

export class MockClock implements Clock {
  constructor(private readonly value = '2026-08-07T01:00:00.000Z') {}

  nowIso(): string {
    return this.value;
  }
}

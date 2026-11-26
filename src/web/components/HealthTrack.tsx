import type { ProviderSummary } from '../../shared/contracts.js';
import { trackDate } from '../data/queries.js';

const dayLabels: Record<string, string> = { '0': '运行正常', '1': '维护', '2': '性能下降', '3': '部分中断', '4': '严重中断', '9': '数据不足' };
export function HealthTrack({ provider, generatedAt }: { provider: ProviderSummary; generatedAt: string }) {
  return <div className="health-track-wrap"><div className="health-track" role="img" aria-label={`${provider.name} 近 30 天状态轨迹；斜纹表示存在未观测时间`}>
    {[...provider.dailyTrack30d].map((status, index) => {
      const coverage = provider.dailyCoverage30d[index]!;
      const label = `${trackDate(generatedAt, index)} UTC · ${dayLabels[status]} · 已观测 ${Math.round(coverage.observedCoverageMinutes)} 分钟 / 未知 ${Math.round(coverage.unknownMinutes)} 分钟`;
      return <span key={index} className={`track-day day-${status}${coverage.unknownMinutes > 0 ? ' has-unknown' : ''}`} title={label} aria-label={label} />;
    })}
  </div><div className="track-axis"><span>30 DAYS AGO</span><span>UTC · TODAY</span></div></div>;
}

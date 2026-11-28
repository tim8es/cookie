import type { OwnerCalendar } from "./owner-calendar-api";
import { groupCalendar } from "./owner-calendar-groups";

const MINUTE = 60000;
const MIN_TARGET = 44;

/** Only projects server-authorized records, never computes availability. */
export function buildDayTimeline(data: OwnerCalendar) {
  if (data.days !== 1 || !data.rangeStartAt || !data.rangeEndAt) return null;
  const start = Date.parse(data.rangeStartAt);
  const end = Date.parse(data.rangeEndAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const duration = (end - start) / MINUTE;
  const minute = (iso: string) => (Date.parse(iso) - start) / MINUTE;
  const earliest = Math.min(...data.entries.map((e) => minute(e.startAt)));
  const latest = Math.max(...data.entries.map((e) => minute(e.endAt)));
  const from = data.entries.length
    ? Math.max(0, Math.floor(earliest / 60) * 60 - 60)
    : 0;
  const to = data.entries.length
    ? Math.min(duration, Math.ceil(latest / 60) * 60 + 60)
    : duration;
  const clock = new Intl.DateTimeFormat("ru-RU", {
    timeZone: data.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const ticks = [];
  for (let offset = from; offset < to; offset += 60) {
    ticks.push({
      top: offset - from,
      label: clock.format(new Date(start + offset * MINUTE)),
    });
  }
  const columns = groupCalendar(data).map((group) => {
    const laneEnds: number[] = [];
    const events = [...group.entries]
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .map((entry) => {
        const top = Math.max(from, minute(entry.startAt)) - from;
        const bottom = Math.min(to, minute(entry.endAt)) - from;
        const height = Math.max(1, bottom - top);
        const targetHeight = Math.max(MIN_TARGET, height);
        let lane = laneEnds.findIndex((value) => value <= top);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = top + targetHeight;
        return {
          entry,
          top,
          height,
          targetHeight,
          lane,
          time: clock.format(new Date(entry.startAt)),
          endTime: clock.format(new Date(entry.endAt)),
          carryIn: minute(entry.startAt) < 0,
          carryOut: minute(entry.endAt) > duration,
        };
      });
    return { ...group, lanes: Math.max(1, laneEnds.length), events };
  });
  return {
    ticks,
    columns,
    height: to - from + MIN_TARGET,
    duration,
  };
}

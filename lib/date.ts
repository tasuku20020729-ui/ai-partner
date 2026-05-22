export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function toDateTimeLocalValue(date = new Date()) {
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function startEndForRelative(text: string, now = new Date()) {
  const d = new Date(now);
  const day = d.getDay();
  const start = new Date(d);
  const end = new Date(d);

  if (text.includes('明後日')) start.setDate(d.getDate() + 2);
  else if (text.includes('明日')) start.setDate(d.getDate() + 1);
  else if (text.includes('昨日')) start.setDate(d.getDate() - 1);
  else if (text.includes('先週')) start.setDate(d.getDate() - 7);
  else if (text.includes('来週')) start.setDate(d.getDate() + 7);

  if (text.includes('今週')) {
    start.setDate(d.getDate() - day);
    end.setDate(start.getDate() + 7);
  } else if (text.includes('今月')) {
    start.setDate(1);
    end.setMonth(start.getMonth() + 1, 1);
  } else {
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 1);
  }

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

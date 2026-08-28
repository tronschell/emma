export function zoned(options: Intl.DateTimeFormatOptions) {
  let offset: number | undefined;
  let format: Intl.DateTimeFormat;
  return (at: Date) => {
    const current = new Date().getTimezoneOffset();
    if (current !== offset) { offset = current; format = new Intl.DateTimeFormat(undefined, options); }
    return format.format(at);
  };
}

const dayFormat = zoned({ month: "short", day: "numeric" });

export const day = (at: number) => at ? dayFormat(new Date(at)) : "—";

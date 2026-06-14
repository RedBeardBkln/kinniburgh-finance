"use client";

interface PeriodPickerProps {
  period: string;
  bucket: string;
  options: { value: string; label: string }[];
}

export function PeriodPicker({ period, bucket, options }: PeriodPickerProps) {
  return (
    <form className="flex items-center gap-2">
      <input type="hidden" name="bucket" value={bucket} />
      <select
        name="period"
        defaultValue={period}
        className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        onChange={(e) => {
          (e.target.form as HTMLFormElement).submit();
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}

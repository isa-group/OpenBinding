export const fmt = (values: any[]): string => `[${values.join(', ')}]`;

export const fmt2d = (rows: any[][]): string =>
  rows.length === 0 ? '[| |]' : `[| ${rows.map((row) => row.join(', ')).join(' | ')} |]`;

import { roomText, roomTone, type RoomRow } from './roomModel';
import './Organization.css';

/** One bar per allowance: solid for what is used, striped for what the change adds. */
export function RoomBars({ rows }: { rows: RoomRow[] }) {
  return (
    <div className="org-room">
      {rows.map((item) => {
        const known = item.used !== null && item.limit !== null && item.limit > 0;
        const usedShare = known ? Math.min(100, Math.round((item.used! / item.limit!) * 100)) : 0;
        const addedShare = known ? Math.max(0, Math.min(100 - usedShare, Math.round((item.added / item.limit!) * 100))) : 0;
        const text = roomText(item);
        return (
          <div className="org-room-row" key={item.id}>
            <div className="org-room-head"><span>{item.label}</span><strong>{text}</strong></div>
            {known ? (
              <div
                className={`org-room-track is-${roomTone(item)}`}
                role="meter"
                aria-label={item.label}
                aria-valuemin={0}
                aria-valuemax={item.limit!}
                aria-valuenow={item.used! + item.added}
                aria-valuetext={`${text}${item.added ? ' after this change' : ''}`}
              >
                <i className="is-used" style={{ width: `${usedShare}%` }} />
                {item.added > 0 && <i className="is-added" style={{ width: `${Math.max(addedShare, 2)}%` }} />}
              </div>
            ) : (
              <div className="org-room-track is-unknown" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}

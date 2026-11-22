export type IconName =
  | "relay"
  | "server"
  | "file"
  | "flow"
  | "chat"
  | "copy"
  | "shield"
  | "plus"
  | "search"
  | "reconnect"
  | "edit"
  | "trash"
  | "close"
  | "tools"
  | "key"
  | "sun"
  | "moon"
  | "monitor";

const PATHS: Record<IconName, string> = {
  relay: '<path d="M4 17l5-10 6 10 5-10M4 17h4m8-10h4"/>',
  server:
    '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9m0-15h6v6m0-6-9 9"/>',
  chat: '<path d="M4 5h16v11H9l-5 4zM8 9h8m-8 3h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H4v12"/>',
  shield: '<path d="m12 3 8 3v5c0 5-3 8-8 10-5-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  reconnect: '<path d="M19 10a7 7 0 1 0-1 7m1-12v5h-5"/>',
  edit: '<path d="m5 15 10-10 4 4L9 19H5zM13 7l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  tools: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-3-3 2-2m-5-1 2-2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="od-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

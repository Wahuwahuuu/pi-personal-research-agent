import {createHash} from "node:crypto";

export const INBOX_NOTICE_CAPABILITY = "inbox-notices-v1";
export const INBOX_NOTICE_PAGE_SIZE = 128;

export interface InboxNoticePage {
  type: "inbox_notices";
  batch: string;
  page: number;
  pages: number;
  ids: string[];
}

export function inboxNoticeBatch(ids: string[]) {
  const pages: string[][] = [];
  const hash = createHash("sha256");
  for (let offset = 0; offset < ids.length; offset += INBOX_NOTICE_PAGE_SIZE) {
    const page = ids.slice(offset, offset + INBOX_NOTICE_PAGE_SIZE);
    pages.push(page);
    hash.update(JSON.stringify(page));
  }
  return {batch: hash.digest("hex"), pages};
}

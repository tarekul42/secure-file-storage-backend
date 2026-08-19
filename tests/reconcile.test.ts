import { describe, expect, it } from "vitest";
import {
  findOrphanedKeys,
  findStaleMultipartUploads,
  isAppKey,
} from "../src/jobs/reconcile.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_UUID = "223e4567-e89b-12d3-a456-426614174000";

describe("reconcile helpers", () => {
  describe("isAppKey", () => {
    it("accepts owner-namespaced app keys", () => {
      expect(isAppKey(`${UUID}/${OTHER_UUID}-report.pdf`)).toBe(true);
    });

    it("rejects keys that are not owner/uuid-named", () => {
      expect(isAppKey("just-a-file.pdf")).toBe(false);
      expect(isAppKey(`${UUID}/plain-name.pdf`)).toBe(false);
      expect(isAppKey("nested/prefix/file.pdf")).toBe(false);
    });
  });

  describe("findOrphanedKeys", () => {
    it("returns app keys present in S3 but missing from the DB", () => {
      const dbKeys = new Set([`${UUID}/${OTHER_UUID}-known.bin`]);
      const s3Keys = [
        `${UUID}/${OTHER_UUID}-known.bin`,
        `${UUID}/${OTHER_UUID}-orphan.bin`,
        "unrelated/object.txt",
      ];

      const orphans = findOrphanedKeys(dbKeys, s3Keys);

      expect(orphans).toEqual([`${UUID}/${OTHER_UUID}-orphan.bin`]);
    });

    it("returns an empty list when nothing is orphaned", () => {
      const key = `${UUID}/${OTHER_UUID}-known.bin`;
      expect(findOrphanedKeys(new Set([key]), [key])).toEqual([]);
    });
  });

  describe("findStaleMultipartUploads", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const stale = {
      Key: `${UUID}/${OTHER_UUID}-stale.bin`,
      UploadId: "upload-1",
      Initiated: new Date("2026-01-01T00:00:00Z"),
    };
    const fresh = {
      Key: `${UUID}/${OTHER_UUID}-fresh.bin`,
      UploadId: "upload-2",
      Initiated: new Date("2026-01-02T12:00:00Z"),
    };

    it("returns only uploads initiated before the cutoff", () => {
      expect(findStaleMultipartUploads([stale, fresh], now)).toEqual([stale]);
    });

    it("returns an empty list when nothing is stale", () => {
      expect(findStaleMultipartUploads([fresh], now)).toEqual([]);
    });
  });
});

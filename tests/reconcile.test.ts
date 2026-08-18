import { describe, expect, it } from "vitest";
import { findOrphanedKeys, isAppKey } from "../src/jobs/reconcile.js";

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
});

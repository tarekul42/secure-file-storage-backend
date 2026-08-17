import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

const s3Config: S3ClientConfig = {
  region: env.AWS_REGION,
};
if (env.S3_ENDPOINT) {
  s3Config.endpoint = env.S3_ENDPOINT;
  s3Config.forcePathStyle = env.AWS_FORCE_PATH_STYLE;
}

export const s3 = new S3Client(s3Config);

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/**
 * Read a JSON object from S3.
 */
export async function readJsonFromS3<T>(bucket: string, key: string): Promise<T> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString('utf-8');
  if (!body) {
    throw new Error(`Empty S3 object: s3://${bucket}/${key}`);
  }
  return JSON.parse(body) as T;
}

/**
 * Write a JSON object to S3.
 */
export async function writeJsonToS3(bucket: string, key: string, data: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json',
    })
  );
}

/**
 * Read a text object from S3 (e.g., raw diff).
 */
export async function readTextFromS3(bucket: string, key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString('utf-8');
  if (!body) {
    throw new Error(`Empty S3 object: s3://${bucket}/${key}`);
  }
  return body;
}

/**
 * Write a text object to S3.
 */
export async function writeTextToS3(bucket: string, key: string, data: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: 'text/plain',
    })
  );
}

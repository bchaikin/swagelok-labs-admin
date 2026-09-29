// Audit trail in DynamoDB: one partition ("audit"), sort key = ISO timestamp + random suffix so
// entries list newest-first with a single Query.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { randomBytes } from 'node:crypto'

export type AuditEntry = {
  at: string
  actor: string
  action: string
  target: string
  details?: Record<string, unknown>
}

const PK = 'audit'

export class Audit {
  private doc: DynamoDBDocumentClient
  private table: string

  constructor(region: string, table: string) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } })
    this.table = table
  }

  async record(entry: Omit<AuditEntry, 'at'>): Promise<AuditEntry> {
    const at = new Date().toISOString()
    const full: AuditEntry = { at, ...entry }
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: PK, sk: `${at}#${randomBytes(4).toString('hex')}`, ...full },
      }),
    )
    return full
  }

  async recent(limit = 100): Promise<AuditEntry[]> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': PK },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 500),
      }),
    )
    return (r.Items ?? []).map((i) => ({
      at: String(i.at),
      actor: String(i.actor),
      action: String(i.action),
      target: String(i.target),
      details: i.details as Record<string, unknown> | undefined,
    }))
  }
}

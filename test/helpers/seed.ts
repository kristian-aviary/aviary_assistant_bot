import { PgConversationReferenceStore } from '../../src/repositories.js';
import type { Db } from '../../src/db.js';
import { CONVERSATION_ID, USER_AAD_ID, USER_ID, USER_TENANT_ID } from './constants.js';

export async function seedReference(db: Db, serviceUrl: string, over: Partial<Parameters<PgConversationReferenceStore['link']>[0]> = {}) {
  return new PgConversationReferenceStore(db).link({
    userId: USER_ID,
    tenantId: USER_TENANT_ID,
    aadObjectId: USER_AAD_ID,
    conversationId: CONVERSATION_ID,
    serviceUrl,
    reference: { channelId: 'msteams' },
    ...over,
  });
}

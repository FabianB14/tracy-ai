// Registration never returns the issued API key to a model. It is saved directly
// in the authenticated operator's encrypted vault before success is reported.
export const registrationSchema = {
  name: 'register_interverse_game',
  description: 'Register a game on Interverse when the authenticated admin explicitly requests it. Requires game ID, game name, developer and studio. Saves the API key in the operator vault, never in chat. Do not retry after an uncertain result or change an existing ID.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      game_id: { type: 'string', description: 'Unique lowercase slug, e.g. gravegold.' },
      game_name: { type: 'string' }, developer_name: { type: 'string' }, studio_name: { type: 'string' },
    }, required: ['game_id', 'game_name', 'developer_name', 'studio_name'],
  },
};

export function createRegistrationHandler({ isAdmin, configured, vaultReady, prepareVault, request, store }) {
  const pending = new Set();
  return async (input = {}, context = {}) => {
    // Unlike dev-only toggles, issuing production credentials always requires
    // an authenticated operator. Self-declared userId is never sufficient.
    if (!context.authUser?.userId || !isAdmin(context)) return { error: 'Game registration requires an authenticated Interverse admin.' };
    if (!configured()) return { error: 'Set INTERVERSE_API_URL and INTERVERSE_ADMIN_KEY on Tracy.' };
    if (!vaultReady()) return { error: 'Set VAULT_SECRET and DATABASE_URL before registration so the issued key can be stored durably and encrypted.' };
    const values = {};
    for (const field of registrationSchema.input_schema.required) {
      if (typeof input?.[field] !== 'string' || !input[field].trim() || input[field].length > 160) return { error: `Provide a valid ${field} (1-160 characters).` };
      values[field] = input[field].trim();
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.game_id)) return { error: 'game_id must be a lowercase slug with optional hyphens.' };
    if (pending.has(values.game_id)) return { error: 'Registration is already in progress for this game. Do not retry.' };
    pending.add(values.game_id);
    try {
      // Prove the encrypted storage path is usable before issuing a credential.
      try { await prepareVault(context.authUser.userId); }
      catch { return { error: 'Credential storage is unavailable; no registration was submitted.' }; }
      let result;
      try {
        result = await request('/games/register', {
          method: 'POST', body: JSON.stringify({
            game_id: values.game_id, game_name: values.game_name,
            developer_name: values.developer_name,
            game_metadata: { studio_name: values.studio_name, updated_by: `tracy:${context.authUser.userId}` },
          }),
        });
      } catch (err) {
        if (err.status === 400) return { error: 'Registration was rejected (the game ID may already exist). Do not retry with a different ID.' };
        if (err.status === 401 || err.status === 403) return { error: 'Interverse rejected the configured admin credential.' };
        return { error: 'Registration outcome is unknown. An operator must check Interverse before any retry.', outcome: 'unknown' };
      }
      if (!result?.success || result.data?.game_id !== values.game_id || typeof result.data?.api_key !== 'string' || !result.data.api_key) {
        return { error: 'Unexpected registration response. Check Interverse before any retry.', outcome: 'unknown' };
      }
      try {
        const receipt = await store({
          sender: context.authUser.userId, recipient: context.authUser.userId,
          label: `Interverse game ${values.game_id} API key`, secret: result.data.api_key,
          oneTime: false,
        });
        return { registered: true, ...values, credential_saved: true, vault_id: receipt.id,
          note: 'The game API key is saved in your encrypted vault. Do not print or request it in chat. Production keys belong in trusted backend configuration, never in the game client.' };
      } catch {
        return { registered: true, game_id: values.game_id, credential_saved: false,
          error: 'The game was registered but key storage failed. Operator credential recovery is required; do not register again.' };
      }
    } finally { pending.delete(values.game_id); }
  };
}

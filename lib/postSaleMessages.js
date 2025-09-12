import FormData from 'form-data';

export function createPostSaleMessages(ml, siteId = process.env.SITE_ID || 'MLB') {
  const tag = 'post_sale';

  return {
    async unread(role = 'seller') {
      const { data } = await ml.get('/messages/unread', { params: { role, tag, site_id: siteId } });
      return data;
    },

    async pack(packId, sellerId, { mark_as_read = true, limit = 10, offset = 0 } = {}) {
      const url = `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}`;
      const { data } = await ml.get(url, { params: { tag, mark_as_read, limit, offset, site_id: siteId } });
      return data;
    },

    async send(packId, sellerId, to_user_id, text, attachments) {
      const url = `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}`;
      const payload = { from: { user_id: String(sellerId) }, to: { user_id: String(to_user_id) }, text: String(text) };
      if (attachments && Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
      const { data } = await ml.post(url, payload, { params: { tag, site_id: siteId }, idempotent: false });
      return data;
    },

    async uploadAttachment(file) {
      if (!file) throw new Error('Arquivo não enviado');
      const form = new FormData();
      form.append('file', file.buffer, { filename: file.originalname });
      const { data } = await ml.post('/messages/attachments', form, {
        params: { tag, site_id: siteId },
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        idempotent: false
      });
      return data;
    },

    async getAttachment(attachmentId) {
      return ml.get(`/messages/attachments/${encodeURIComponent(attachmentId)}`, {
        params: { tag, site_id: siteId },
        responseType: 'arraybuffer'
      });
    }
  };
}

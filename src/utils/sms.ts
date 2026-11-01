// No SMS provider yet, so messages only go to the server log. Connect the paid provider here.
export const sendSms = (to: string, message: string): Promise<void> => {
  console.info(`[sms] not sent, no provider yet. To ...${to.slice(-4)}: ${message}`);
  return Promise.resolve();
};

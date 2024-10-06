import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  onDocumentCreated,
  onDocumentDeleted,
} from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { ServerClient, TemplatedMessage } from "postmark";
import { shortenString } from "./stringUtils";
import { Helius } from "helius-sdk";

enum Secrets {
  PostMarkApiKey = "POSTMARK_API_KEY",
  HeliusApiKey = "HELIUS_API_KEY",
  HeliusAuthHeader = "HELIUS_AUTH_HEADER",
}

const app = initializeApp();
logger.info("Firebase initialized");

const enum FirestoreCollections {
  Config = "config",
  Alerts = "alerts",
  SentAlerts = "sent-alerts",
}

const HELIUS_WEBHOOK_ID = "57c97f58-8214-4c09-8257-32f3b331dfe5";

export const transactionUpdate = onRequest(
  { secrets: [Secrets.PostMarkApiKey, Secrets.HeliusAuthHeader] },
  async (request, response) => {
    // helius webhook callback
    logger.info("Helius webhook callback");

    if (request.method != "POST") {
      logger.error("Method not allowed: ", request.method);
      response.status(405).send(`Method ${request.method} not allowed`);
      return;
    }

    // Validate auth header
    const authHeader = request.get("Authorization");
    logger.info("Got auth header");

    if (authHeader !== process.env.HELIUS_AUTH_HEADER) {
      logger.error("Unauthorized request. Supplied auth header:", authHeader);
      response.status(401).send("Unauthorized");
      return;
    }

    logger.info("Auth header validated");

    console.log("Request body: ", JSON.stringify(request.body));

    // Derive wallet addresses from helius callback

    const accountData = request.body[0].accountData;
    console.log("Account data: ", accountData);
    logger.info("Count of impacted accounts: " + accountData.length);

    const txDescription = request.body[0].description;

    var successEmails = 0;
    var failedEmails = 0;

    const firestore = getFirestore(app);
    logger.info("Firestore initialized");

    const postmarkApiKey = process.env.POSTMARK_API_KEY;
    if (!postmarkApiKey) {
      const errorMessage = "Postmark API key not found";
      console.error(errorMessage);
      throw Error(errorMessage);
    }
    var postmarkClient = new ServerClient(postmarkApiKey);

    const accountAddresses = accountData.map((data: any) => data.account);

    for (const walletAddress of accountAddresses) {
      // TODO: If alert doesn't exist for wallet address, remove webhook from helius

      const shortenedAddress = shortenString(walletAddress);

      logger.info("Received transaction update for wallet: ", shortenedAddress);

      const alerts = await firestore
        .collection(FirestoreCollections.Alerts)
        .where("walletAddress", "==", walletAddress)
        .get();

      logger.info("Alerts found: ", alerts.docs.length);

      const alertDocs = alerts.docs;

      logger.info("Alerts found: ", alertDocs.length);

      // Send an email

      const sentAlertsCollection = firestore.collection(
        FirestoreCollections.SentAlerts
      );

      for (const alertDoc of alertDocs) {
        const alert = alertDoc.data();
        try {
          console.log("Sending email to: ", alert.email);

          const templatedMessage: TemplatedMessage = {
            From: "info@solsignal.xyz",
            To: alert.email,
            MessageStream: "alert-email-stream",
            TemplateAlias: "solsignal-transaction-alert",
            TemplateModel: {
              shortenedWalletAddress: shortenedAddress,
              walletAddress,
              txDescription,
              alertUrl: "https://solsignal.xyz/alerts/" + alertDoc.id,
              loginUrl: "https://solsignal.xyz/login",
              email: alert.email,
              supportEmail: "info@solsignal.xyz",
            },
          };

          await postmarkClient.sendEmailWithTemplate(templatedMessage);

          await sentAlertsCollection.add({
            createdAt: Date.now(),
            status: "success",
            ...alert,
          });

          successEmails++;
        } catch (error) {
          console.error(
            "Failed to send email to",
            alert.email,
            "Error: ",
            error
          );
          await sentAlertsCollection.add({
            createdAt: Date.now(),
            status: "fail",
            ...alert,
          });
          failedEmails++;
        }
      }
    }

    console.log(
      "Emails sent. Success count: ",
      successEmails,
      "Failed count: ",
      failedEmails
    );

    response.status(200).send("OK");
  }
);

export const alertCreated = onDocumentCreated(
  {
    document: "alerts/{documentId}",
    secrets: [Secrets.HeliusAuthHeader],
  },
  async (event) => {
    console.log("onDocumentCreated event: ", event);
    const querySnapshot: QueryDocumentSnapshot | undefined = event.data;
    const alert = querySnapshot?.data();
    const alertId = querySnapshot?.ref.id;

    console.log("alertId: ", alertId);

    logger.info(
      "Yay! Alert document created in Firestore for wallet: ",
      alert?.walletAddress
    );

    const heliusApiKey = process.env.HELIUS_API_KEY;

    if (!heliusApiKey) {
      const errorMessage = "Helius API key not found";
      console.error(errorMessage);
      throw Error(errorMessage);
    }

    const helius = new Helius(heliusApiKey);

    // const webhook = await helius.createWebhook({
    //   accountAddresses: [alert?.walletAddress],
    //   transactionTypes: [TransactionType.ANY],
    //   webhookType: WebhookType.ENHANCED,
    //   webhookURL: "https://api.solsignal.xyz/transactionupdate",
    //   authHeader: HELIUS_AUTH_HEADER,
    // });

    // logger.info("Webhook created: ", webhook);
    // logger.info("Webhook ID: ", webhook.webhookID);

    await helius.appendAddressesToWebhook(HELIUS_WEBHOOK_ID, [
      alert?.walletAddress,
    ]);

    await updateSystemAlertCount();

    logger.info("Address appended to webhook with ID: ", HELIUS_WEBHOOK_ID);

    return querySnapshot?.ref.set(
      {
        webhookID: HELIUS_WEBHOOK_ID,
      },
      { merge: true }
    );
  }
);

export const alertDeleted = onDocumentDeleted(
  {
    document: "alerts/{documentId}",
    secrets: [Secrets.HeliusApiKey],
  },
  async (event) => {
    const alert = event.data?.data();

    const heliusApiKey = process.env.HELIUS_API_KEY;

    if (!heliusApiKey) {
      const errorMessage = "Helius API key not found";
      console.error(errorMessage);
      throw Error(errorMessage);
    }

    const helius = new Helius(heliusApiKey);

    await helius.removeAddressesFromWebhook(HELIUS_WEBHOOK_ID, [
      alert?.walletAddress,
    ]);

    // const result = await helius.deleteWebhook(alert?.webhookID);
    // logger.info("Webhook deleted. Result: ", result);

    await updateSystemAlertCount();

    logger.info("Address removed from webhook with ID: ", HELIUS_WEBHOOK_ID);
  }
);

async function updateSystemAlertCount() {
  const firestore = getFirestore(app);
  logger.info("Firestore initialized");

  const alertCountSnapshot = await firestore
    .collection(FirestoreCollections.Alerts)
    .count()
    .get();

  const alertCount = alertCountSnapshot.data().count;

  logger.info("Found alert count: ", alertCount);

  await firestore
    .collection(FirestoreCollections.Config)
    .doc("solsignal")
    .set({ systemAlertCount: alertCount });

  logger.info("System alert count updated to: ", alertCount);
}

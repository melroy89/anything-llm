process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();
const { validateTablePragmas } = require("../utils/database");
const { viewLocalFiles } = require("../utils/files");
const { exportData, unpackAndOverwriteImport } = require("../utils/files/data");
const {
  checkPythonAppAlive,
  acceptedFileTypes,
} = require("../utils/files/documentProcessor");
const { purgeDocument } = require("../utils/files/purgeDocument");
const { getVectorDbClass } = require("../utils/helpers");
const { updateENV } = require("../utils/helpers/updateENV");
const {
  reqBody,
  makeJWT,
  userFromSession,
  multiUserMode,
} = require("../utils/http");
const { setupDataImports } = require("../utils/files/multer");
const { v4 } = require("uuid");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { handleImports } = setupDataImports();

function systemEndpoints(app) {
  if (!app) return;

  app.get("/ping", (_, response) => {
    response.sendStatus(200);
  });

  app.get("/migrate", async (_, response) => {
    await validateTablePragmas(true);
    response.sendStatus(200);
  });

  app.get("/setup-complete", async (_, response) => {
    try {
      const llmProvider = process.env.LLM_PROVIDER || "openai";
      const vectorDB = process.env.VECTOR_DB || "pinecone";
      const results = {
        CanDebug: !!!process.env.NO_DEBUG,
        RequiresAuth: !!process.env.AUTH_TOKEN,
        AuthToken: !!process.env.AUTH_TOKEN,
        JWTSecret: !!process.env.JWT_SECRET,
        StorageDir: process.env.STORAGE_DIR,
        MultiUserMode: await SystemSettings.isMultiUserMode(),
        VectorDB: vectorDB,
        ...(vectorDB === "pinecone"
          ? {
              PineConeEnvironment: process.env.PINECONE_ENVIRONMENT,
              PineConeKey: !!process.env.PINECONE_API_KEY,
              PineConeIndex: process.env.PINECONE_INDEX,
            }
          : {}),
        ...(vectorDB === "chroma"
          ? {
              ChromaEndpoint: process.env.CHROMA_ENDPOINT,
            }
          : {}),
        ...(vectorDB === "weaviate"
          ? {
              WeaviateEndpoint: process.env.WEAVIATE_ENDPOINT,
              WeaviateApiKey: process.env.WEAVIATE_API_KEY,
            }
          : {}),
        LLMProvider: llmProvider,
        ...(llmProvider === "openai"
          ? {
              OpenAiKey: !!process.env.OPEN_AI_KEY,
              OpenAiModelPref: process.env.OPEN_MODEL_PREF || "gpt-3.5-turbo",
            }
          : {}),

        ...(llmProvider === "azure"
          ? {
              AzureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
              AzureOpenAiKey: !!process.env.AZURE_OPENAI_KEY,
              AzureOpenAiModelPref: process.env.OPEN_MODEL_PREF,
              AzureOpenAiEmbeddingModelPref: process.env.EMBEDDING_MODEL_PREF,
            }
          : {}),
      };
      response.status(200).json({ results });
    } catch (e) {
      console.log(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/check-token",
    [validatedRequest],
    async (request, response) => {
      try {
        if (multiUserMode(response)) {
          const user = await userFromSession(request, response);
          if (!user || user.suspended) {
            response.sendStatus(403).end();
            return;
          }

          response.sendStatus(200).end();
          return;
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post("/request-token", async (request, response) => {
    try {
      if (await SystemSettings.isMultiUserMode()) {
        const { username, password } = reqBody(request);
        const existingUser = await User.get(`username = '${username}'`);

        if (!existingUser) {
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[001] Invalid login credentials.",
          });
          return;
        }

        const bcrypt = require("bcrypt");
        if (!bcrypt.compareSync(password, existingUser.password)) {
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[002] Invalid login credentials.",
          });
          return;
        }

        if (existingUser.suspended) {
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: "[004] Account suspended by admin.",
          });
          return;
        }

        response.status(200).json({
          valid: true,
          user: existingUser,
          token: makeJWT(
            { id: existingUser.id, username: existingUser.username },
            "30d"
          ),
          message: null,
        });
        return;
      } else {
        const { password } = reqBody(request);
        if (password !== process.env.AUTH_TOKEN) {
          response.status(401).json({
            valid: false,
            token: null,
            message: "[003] Invalid password provided",
          });
          return;
        }

        response.status(200).json({
          valid: true,
          token: makeJWT({ p: password }, "30d"),
          message: null,
        });
      }
    } catch (e) {
      console.log(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/system/system-vectors", [validatedRequest], async (_, response) => {
    try {
      const VectorDb = getVectorDbClass();
      const vectorCount = await VectorDb.totalIndicies();
      response.status(200).json({ vectorCount });
    } catch (e) {
      console.log(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.delete(
    "/system/remove-document",
    [validatedRequest],
    async (request, response) => {
      try {
        const { name, meta } = reqBody(request);
        await purgeDocument(name, meta);
        response.sendStatus(200).end();
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/system/local-files", [validatedRequest], async (_, response) => {
    try {
      const localFiles = await viewLocalFiles();
      response.status(200).json({ localFiles });
    } catch (e) {
      console.log(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/document-processing-status",
    [validatedRequest],
    async (_, response) => {
      try {
        const online = await checkPythonAppAlive();
        response.sendStatus(online ? 200 : 503);
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/accepted-document-types",
    [validatedRequest],
    async (_, response) => {
      try {
        const types = await acceptedFileTypes();
        if (!types) {
          response.sendStatus(404).end();
          return;
        }

        response.status(200).json({ types });
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-env",
    [validatedRequest],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const { newValues, error } = updateENV(body);
        response.status(200).json({ newValues, error });
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-password",
    [validatedRequest],
    async (request, response) => {
      try {
        const { usePassword, newPassword } = reqBody(request);
        const { error } = updateENV({
          AuthToken: usePassword ? newPassword : "",
          JWTSecret: usePassword ? v4() : "",
        });
        response.status(200).json({ success: !error, error });
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/enable-multi-user",
    [validatedRequest],
    async (request, response) => {
      try {
        const { username, password } = reqBody(request);
        const multiUserModeEnabled = await SystemSettings.isMultiUserMode();
        if (multiUserModeEnabled) {
          response.status(200).json({
            success: false,
            error: "Multi-user mode is already enabled.",
          });
          return;
        }

        const { user, error } = await User.create({
          username,
          password,
          role: "admin",
        });
        await SystemSettings.updateSettings({
          multi_user_mode: true,
          users_can_delete_workspaces: false,
          limit_user_messages: false,
          message_limit: 25,
        });
        process.env.AUTH_TOKEN = null;
        process.env.JWT_SECRET = process.env.JWT_SECRET ?? v4(); // Make sure JWT_SECRET is set for JWT issuance.
        response.status(200).json({ success: !!user, error });
      } catch (e) {
        console.log(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/system/data-export", [validatedRequest], async (_, response) => {
    try {
      const { filename, error } = await exportData();
      response.status(200).json({ filename, error });
    } catch (e) {
      console.log(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/data-exports/:filename",
    [validatedRequest],
    (request, response) => {
      const filePath =
        __dirname + "/../storage/exports/" + request.params.filename;
      response.download(filePath, request.params.filename, (err) => {
        if (err) {
          response.send({
            error: err,
            msg: "Problem downloading the file",
          });
        }
      });
    }
  );

  app.post(
    "/system/data-import",
    handleImports.single("file"),
    async function (request, response) {
      const { originalname } = request.file;
      const { success, error } = await unpackAndOverwriteImport(originalname);
      response.status(200).json({ success, error });
    }
  );
}

module.exports = { systemEndpoints };

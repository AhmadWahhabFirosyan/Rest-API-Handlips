require("dotenv").config();
const express = require("express");
const { Sequelize, DataTypes } = require("sequelize");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const cors = require("cors");

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Welcome to the jungle",
    version: "1.0.0",
  });
});
// Health check route
app.get("/health", (req, res) => {
  res.json({
    success: true,
    timestamp: new Date(),
    uptime: process.uptime(),
    status: "healthy",
  });
});

// Database setup with Sequelize
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql",
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  }
);

// Model definitions
const Soundboard = sequelize.define("Soundboard", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  audioUrl: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdByEmail: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

// Google Cloud Setup
let storage;
let ttsClient;
let bucket;

try {
  storage = new Storage({
    keyFilename: path.join(__dirname, "gcp-key.json"),
    projectId: process.env.GCP_PROJECT_ID,
  });

  bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

  ttsClient = new textToSpeech.TextToSpeechClient({
    keyFilename: path.join(__dirname, "gcp-key.json"),
  });
} catch (error) {
  console.error("Error initializing Google Cloud services:", error);
}

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/jpg"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File harus berupa gambar."));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// Helper Functions
const generateSpeech = async (text) => {
  try {
    const request = {
      input: { text },
      voice: { languageCode: "id-ID", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    return response.audioContent;
  } catch (error) {
    throw new Error(`Error generating speech: ${error.message}`);
  }
};

const uploadToGCS = async (buffer, filename, contentType = "audio/mpeg") => {
  const file = bucket.file(filename);

  try {
    await file.save(buffer, {
      contentType: contentType,
      metadata: {
        cacheControl: "public, max-age=31536000",
      },
    });

    const publicUrl = `https://storage.googleapis.com/${process.env.GCP_BUCKET_NAME}/${filename}`;
    return publicUrl;
  } catch (error) {
    throw new Error(
      `Error uploading to Google Cloud Storage: ${error.message}`
    );
  }
};

// API ROUTES
// API SOUNDBOARDS
app.post("/soundboards", async (req, res) => {
  try {
    const { title, text, email } = req.body;

    if (!title || !text || !email) {
      return res
        .status(400)
        .json({ error: "Title, text, and email are required" });
    }

    const audioBuffer = await generateSpeech(text);

    const fileName = `${uuidv4()}.mp3`;
    const audioUrl = await uploadToGCS(audioBuffer, fileName);

    const soundboard = await Soundboard.create({
      text,
      title,
      audioUrl,
      fileName,
      createdByEmail: email, // Simpan email pengguna
    });

    res.status(201).json({
      success: true,
      message: "Soundboard created successfully",
      data: soundboard,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to create soundboard",
    });
  }
});

app.get("/soundboards/:email", async (req, res) => {
  try {
    const { email } = req.params;

    // Mengambil data soundboard dari database berdasarkan email
    const soundboards = await Soundboard.findAll({
      where: { createdByEmail: email },
      order: [["createdAt", "DESC"]],
    });

    if (soundboards.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No soundboards found for this email",
      });
    }

    // Validasi ketersediaan file di Google Cloud Storage
    const validatedSoundboards = await Promise.all(
      soundboards.map(async (soundboard) => {
        const filename = soundboard.audioUrl.split("/").pop();
        const file = bucket.file(filename);

        try {
          // Memeriksa apakah file ada di Google Cloud Storage
          const [exists] = await file.exists();
          return {
            ...soundboard.toJSON(),
            fileExists: exists, // Menambahkan status ketersediaan file
          };
        } catch (error) {
          console.error(`Error checking file: ${error.message}`);
          return {
            ...soundboard.toJSON(),
            fileExists: false, // Jika ada error, anggap file tidak tersedia
          };
        }
      })
    );

    res.json({
      success: true,
      message: "Soundboards retrieved successfully",
      data: validatedSoundboards,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch soundboards",
    });
  }
});

app.delete("/soundboards/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const soundboard = await Soundboard.findByPk(id);
    if (!soundboard) {
      return res.status(404).json({
        success: false,
        message: "Soundboard not found",
      });
    }

    const filename = soundboard.audioUrl.split("/").pop();
    const file = bucket.file(filename);

    try {
      await file.delete();
    } catch (error) {
      console.error(`Failed to delete file: ${error.message}`);
    }

    await soundboard.destroy();

    res.json({
      success: true,
      message: "Soundboard deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to delete soundboard",
    });
  }
});

// API HISTORY
app.post("/history", async (req, res, next) => {
  try {
    const { id, title, message, is_speech_to_text, email } = req.body;

    // Validasi input
    if (
      !id ||
      !title ||
      !message ||
      is_speech_to_text === undefined ||
      !email
    ) {
      return res.status(400).json({
        status: "error",
        message: "Id, Judul, Pesan, is_speech_to_text, dan email harus diisi",
      });
    }

    // Mengambil waktu saat ini untuk created_at
    const createdAt = new Date();

    // Query untuk memasukkan data ke dalam tabel history
    const [result] = await sequelize.query(
      "INSERT INTO history (id, title, message, created_at, is_speech_to_text, email) VALUES (?, ?, ?, ?, ?, ?)",
      {
        replacements: [id, title, message, createdAt, is_speech_to_text, email],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      status: "success create data",
      data: {
        id,
        title,
        message,
        created_at: createdAt,
        is_speech_to_text,
        email,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/history", async (req, res, next) => {
  try {
    const histories = await sequelize.query(
      "SELECT * FROM history ORDER BY created_at DESC",
      {
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (histories.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "History tidak ditemukan",
      });
    }

    const formattedHistories = histories.map((history) => ({
      id: history.id,
      title: history.title,
      message: [
        {
          text: history.message,
          created_at: history.created_at,
          is_speech_to_text: history.is_speech_to_text,
        },
      ],
      detection_type: history.is_speech_to_text
        ? "Speech to Text"
        : "Gesture Detection",
    }));

    res.json({
      status: "success get data",
      data: formattedHistories,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      status: "error",
      message: error.message || "Something went wrong",
    });
  }
});

app.get("/history/:id", async (req, res, next) => {
  try {
    const { id } = req.params; // Ambil ID dari parameter
    console.log("Searching for history with ID:", id); // Logging ID

    const history = await History.findByPk(id);

    if (!history) {
      return res.status(404).json({
        status: "error",
        message: "History tidak ditemukan",
      });
    }

    const formattedHistory = {
      id: history.id,
      title: history.title,
      message: [
        {
          text: history.message,
          created_at: history.created_at,
          is_speech_to_text: history.is_speech_to_text,
        },
      ],
      detection_type: history.is_speech_to_text
        ? "Speech to Text"
        : "Gesture Detection",
    };

    res.json({
      status: "success get data",
      data: [formattedHistory],
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/history/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // Mencari data berdasarkan id
    const history = await History.findByPk(id);

    if (!history) {
      return res.status(404).json({
        status: "error",
        message: "History tidak ditemukan",
      });
    }

    // Menghapus data
    await history.destroy();

    res.json({
      status: "success",
      message: `History dengan ID ${id} telah dihapus`,
    });
  } catch (error) {
    next(error);
  }
});

// API PROFILE
app.post("/profile", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required",
      });
    }

    const existingProfile = await sequelize.query(
      "SELECT * FROM profile WHERE email = ?",
      {
        replacements: [email],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existingProfile.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Email already exists",
      });
    }

    await sequelize.query("INSERT INTO profile (name, email) VALUES (?, ?)", {
      replacements: [name, email],
      type: Sequelize.QueryTypes.INSERT,
    });

    res.status(201).json({
      success: true,
      message: "Profile created successfully",
      data: { name, email },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/profile/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const [profile] = await sequelize.query(
      "SELECT * FROM profile WHERE email = ?",
      {
        replacements: [email],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found",
      });
    }

    res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.put(
  "/profile/:email",
  upload.single("profile_picture"),
  async (req, res) => {
    try {
      const { email } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Name is required",
        });
      }

      let profilePictureUrl = null;

      // Jika ada file gambar
      if (req.file) {
        const filename = `profiles/${Date.now()}-${req.file.originalname}`;
        profilePictureUrl = await uploadToGCS(
          req.file.buffer,
          filename,
          req.file.mimetype
        );
      }

      const updateQuery = profilePictureUrl
        ? "UPDATE profile SET name = ?, profile_picture_url = ? WHERE email = ?"
        : "UPDATE profile SET name = ? WHERE email = ?";

      const replacements = profilePictureUrl
        ? [name, profilePictureUrl, email]
        : [name, email];

      const [result] = await sequelize.query(updateQuery, {
        replacements,
        type: Sequelize.QueryTypes.UPDATE,
      });

      if (result === 0) {
        return res.status(404).json({
          success: false,
          message: "Profile not found",
        });
      }

      res.json({
        success: true,
        message: "Profile updated successfully",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// API FEEDBACK
app.post("/feedback", async (req, res) => {
  try {
    const { comment, rating } = req.body;

    if (!comment || !rating) {
      return res.status(400).json({
        success: false,
        message: "Rating harus diisi",
      });
    }

    if (rating < 1 || rating > 4) {
      return res.status(400).json({
        success: false,
        message: "Rating harus antara 1-4",
      });
    }

    const [result] = await sequelize.query(
      "INSERT INTO feedback (comment, rating) VALUES (?, ?)",
      {
        replacements: [comment, rating],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      success: true,
      data: {
        id: result,
        comment,
        rating,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

//API REPORT
// Model definitions
const Report = sequelize.define(
  "Report",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    timestamps: true, // Menambahkan createdAt dan updatedAt otomatis
  }
);

// POST /report - Membuat report baru
app.post("/report", async (req, res) => {
  try {
    const { comment } = req.body;

    if (!comment) {
      return res.status(400).json({
        success: false,
        message: "Comment harus diisi",
      });
    }

    const report = await Report.create({ comment });

    res.status(201).json({
      success: true,
      data: {
        id: report.id,
        comment: report.comment,
        createdAt: report.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET /report - Mendapatkan semua report dengan pagination
app.get("/report", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query; // Query pagination
    const offset = (page - 1) * limit;

    const { count, rows: reports } = await Report.findAndCountAll({
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["createdAt", "DESC"]],
    });

    res.json({
      success: true,
      total: count,
      currentPage: parseInt(page),
      totalPages: Math.ceil(count / limit),
      data: reports,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: err.message,
  });
});

// Server & Database Initialization
const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    // Sync database
    await sequelize.sync();
    console.log("Database synced successfully");

    // Start server
    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
      console.log(`Test API at: http://localhost:${PORT}`);
      console.log("\nAvailable routes:");
      console.log("- POST   /soundboards");
      console.log("- GET    /soundboards");
      console.log("- POST   /history");
      console.log("- GET    /history");
      console.log("- GET    /history/:id");
      console.log("- GET    /profile");
      console.log("- PUT    /profile");
      console.log("- POST   /feedback");
    });
  } catch (error) {
    console.error("Unable to start server:", error);
    process.exit(1);
  }
};

start();

import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// Release signing secrets live in an untracked keystore.properties (see keystore.properties.example).
// If it's missing, the release build is produced unsigned (CI / other contributors).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKey = keystoreProps.getProperty("storeFile")?.isNotBlank() == true

android {
    namespace = "app.umbrapdf"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "app.umbrapdf"
        minSdk = 24
        targetSdk = 37
        versionCode = 2
        versionName = "1.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        // Public, throwaway key for test builds made by GitHub Actions ("Umbra PDF (dev)", app.umbrapdf.dev).
        // It can't sign or update the real app, which uses the private release key above.
        create("dev") {
            storeFile = file("dev.keystore")
            storePassword = "umbra-dev-public"
            keyAlias = "umbradev"
            keyPassword = "umbra-dev-public"
        }
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        // Test build: same as release (shrunk, not debuggable) but a separate app that installs next to the real one.
        create("dev") {
            initWith(getByName("release"))
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            signingConfig = signingConfigs.getByName("dev")
            matchingFallbacks += listOf("release")
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
            }
        }
        release {
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    // Web core lives in src/main/assets/web (built from /core via `npm run sync:android`).
    androidResources {
        noCompress += listOf("gz", "wasm", "onnx")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    // Native PaddleOCR runtime (MIT). Only the 64-bit ARM (phones) and x86_64 (emulator) libraries are packed.
    implementation(libs.onnxruntime.android)
    testImplementation(libs.junit)
    // Unit tests run the same OCR code on the build machine with the desktop ONNX Runtime.
    testImplementation(libs.onnxruntime.jvm)
    testImplementation(libs.orgjson) // real org.json (android.jar only has stubs)
}

// The Android runtime can't load on the build machine: unit tests use the desktop one instead.
configurations.matching { it.name.contains("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}

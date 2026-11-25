import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing. keystore.properties (storeFile, storePassword, keyAlias, keyPassword) sits next to this
// project's settings.gradle.kts and is never committed; back it up with the .jks it names. Without it,
// release builds fall back to the local debug key, which can't update installed copies.
val keystoreProps = rootProject.file("keystore.properties").takeIf { it.exists() }?.let { f ->
    Properties().apply { f.inputStream().use(::load) }
}

// The release tag on GitHub must match this, with a leading "v", for the in-app update check.
val appVersion = providers.gradleProperty("appVersion").getOrElse("1.4.7")
val updateApi = providers.gradleProperty("updateApi")
    .getOrElse("https://api.github.com/repos/zapiltar/OpenGuide/releases/latest")
// Bar Mode's server (server/ in this repo). -PbarApi= (empty) hides Bar Mode. To test against `npm run dev`,
// build with -PbarApi=http://<this PC's address>:8787 (or http://10.0.2.2:8787 from an emulator).
val barApi = providers.gradleProperty("barApi").getOrElse("https://openguide-bar.openguide-bar-server.workers.dev")

android {
    namespace = "com.openguide.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.openguide.tv"
        // Fire OS 5 is API 22; Fire OS 8 is API 30.
        minSdk = 22
        targetSdk = 34
        versionCode = appVersion.split('.').fold(0) { acc, part -> acc * 100 + part.toInt() }
        versionName = appVersion
        buildConfigField("String", "UPDATE_API", "\"$updateApi\"")
        buildConfigField("String", "BAR_API", "\"$barApi\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystoreProps != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // Installs beside the released app, so testing doesn't mean uninstalling it.
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val media3 = "1.8.0"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-exoplayer-dash:$media3")
    implementation("androidx.media3:media3-datasource-okhttp:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt:coil-base:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    // Android's own org.json is only a stub in local unit tests.
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("junit:junit:4.13.2")
}

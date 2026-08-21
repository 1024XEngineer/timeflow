package com.timeflow.alarm

object LocationSnapshotReader {
  @JvmStatic
  fun readProviderSnapshot(
    provider: String,
    readSnapshot: (String) -> LocationSnapshot?,
  ): LocationSnapshot? {
    return runCatching { readSnapshot(provider) }.getOrNull()
  }
}

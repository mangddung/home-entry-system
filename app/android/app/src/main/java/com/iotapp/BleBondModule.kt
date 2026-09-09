package com.iotapp

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// Android는 본딩(페어링) 해제 공개 API가 없다. BluetoothDevice.removeBond()는
// 리플렉션으로만 접근 가능한 hidden API — 실패하면 false를 돌려주고 넘어간다.
// ponytail: 리플렉션 1개. 향후 공개 API 생기면 그걸로 교체.
class BleBondModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName() = "BleBond"

  private fun adapter(): BluetoothAdapter? =
    (reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  @ReactMethod
  fun removeBond(address: String, promise: Promise) {
    try {
      val adapter = adapter()
      if (adapter == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
        promise.resolve(false)
        return
      }
      val device = adapter.getRemoteDevice(address)
      if (device.bondState == BluetoothDevice.BOND_NONE) {
        promise.resolve(true)
        return
      }
      val removed = BluetoothDevice::class.java.getMethod("removeBond").invoke(device) as? Boolean
      promise.resolve(removed == true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun bondedDevices(promise: Promise) {
    val result = Arguments.createArray()
    try {
      adapter()?.bondedDevices?.forEach { device ->
        val entry = Arguments.createMap()
        entry.putString("address", device.address)
        entry.putString("name", device.name)
        result.pushMap(entry)
      }
    } catch (e: SecurityException) {
      // BLUETOOTH_CONNECT 미허용 – 빈 목록
    }
    promise.resolve(result)
  }
}

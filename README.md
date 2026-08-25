# LAN Territory Battle

2〜10人で遊ぶLAN対戦バカゲー。

## 現在の仕様

- CPUなし、全員プレイヤー
- LAN上のブラウザから参加
- プレイヤーは常に前進
- A / D または ← / → で方向転換
- 押している間は0.01秒間隔で15°ずつ回転
- 歩いた場所を自分のインクで塗る
- 領土が0になったプレイヤーは脱落
- 水色ボタン「雨」で全員のインクが溶け、各プレイヤーの本拠地1マスだけ残る予定

## 起動

```powershell
python -m pip install -r requirements.txt
python server.py
```

同じLAN内の各PCから `http://サーバーPCのIP:8080/` にアクセスします。

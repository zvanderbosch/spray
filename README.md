# Spray

A React web-based app allowing users to build and save climbing routes on their own custom climbing walls. Simply upload a picture of your climbing wall and start setting!

## Disclaimer

I am not an App developer

## Requirements

You will need to have the following software installed on your machine in order to properly run and serve this App on your local network:

* Node.js
    * `sudo apt install nodejs`
* npm
    * `sudo apt install npm`

## Getting Started

If you would like to use this App for your own climbing wall, start by cloning this repository onto your own machine:

```bash
git clone https://github.com/zvanderbosch/spray.git
```

Move into the **spray** directory and then install all of the necessary packages with **npm**:

```bash
cd spray
npm install
```

Create a **db.json** file in the **spray** directory with the following contents:

```json
{
    "walls": [],
    "routes": []
}
```

This file will serve as the database storing your library of climbing walls and associated routes. You will also need to create a **.env** file in the **spray** directory with the following contents:

```javascript
VITE_API_URL=http://YOUR_COMPUTER_IP:3001
```

Replace `YOUR_COMPUTER_IP` with your computer's local IP address. You can find this IP address from the command line using one of the following commands:

```bash
ip address | grep inet
```
or
```bash
ifconfig -a | grep inet
```
or
```bash
hostname -I
```

If you are still not sure what IP address to use, you can also try running `npm run dev` which will print out the IP address being used to serve the app., such as:

```
  ➜  Network: http://YOUR_COMPUTER_IP:3000/
```

## Running the App

With the above steps complete, simply run the following from your **spray** directory:

```bash
npm run dev:all
```

Now, any device that is connected to the same internet as the device that's running the app will be able to access the app on a browser at the **Network** address printed out on the command line, such as:

```
  VITE v7.3.1  ready in 121 ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: http://YOUR_COMPUTER_IP:3000/
  ➜  press h + enter to show help
```
var fs = require("fs");
const mime = require("mime");

export const fileSave = (img) => {
  try {
    const path = "public/images";
    const base64Image = img;
    const matches = base64Image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    //file not exist or not valid
    if (!base64Image || matches.length !== 3) {
      return false;
    }
    //file saving
    let imageBuffer = Buffer.from(matches[2], "base64");
    let type = matches[1];
    let extension = mime.extension(type);
    let fileName = Date.now() + "." + extension;
    //call back is providing async behavior, if there will be no call then
    //will need to write fs.writeFileSync
    fs.writeFile(path + "/" + fileName, imageBuffer, function (err) {
      if (err) {
        return false;
      }
    });
    return fileName;
  } catch (err) {
    return false;
    //console.log(`Error in uploading/saving file ${err}}`)
  }
};

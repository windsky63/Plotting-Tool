// 氚云表单上传服务

class H3yunService {
  constructor() {
    // 氚云API配置 - 需要根据实际情况配置
    this.baseUrl = 'https://www.h3yun.com/api';
    this.appCode = 'YOUR_APP_CODE';
    // 使用与旧版相同的主表编码（数据工作日志表单）
    this.formCode = 'D148357st1mm2l5ga0ucn4ogzl05'; // 主表编码
    this.subtableCode = 'D148357F67d10547274c48d7bc977b28a4a9c6a6'; // 子表编码
    this.engineCode = 'YOUR_ENGINE_CODE';
    
    // 人员ID映射
    this.USER_ID_MAP = {
      "纪婕": "592eb0aa-3840-4cee-ad59-5fe4b8816214",
      "张丽妹": "69ea8dd7-e3c5-4f4f-860c-5e73ae7ba3ac",
      "曹传章妈妈": "6eee8037-40d2-440b-a4c6-628fcbd8d77b",
      "陶炎": "7ef6e048-6868-442d-b495-d2aa193168c0",
      "沙雪平": "8d1b7663-10d1-4f91-a647-f9cccb1e3fd4",
      "凌秋月": "ac4cfca9-80ca-4499-b98f-27127563289f",
      "谷成浩": "b994b99c-16e6-467f-8579-806177709436",
      "王井会": "c36f9c28-895e-4f98-ab08-8fe8276dd7eb",
      "赵玲": "c4c2824b-300d-4700-a6bc-1ee608fbb110",
      "吴冠桦": "dbe65f22-5a9a-4510-a951-577ee6b0a59f",
      "殷玉善": "dcdf8bd9-e8c2-425c-a56d-d321a1e20fa2"
    };
  }

  /**
   * 通用氚云请求方法 - 支持 Electron 和 Web 环境
   */
  async tritiumRequest(requestData) {
    if (window.electronAPI && window.electronAPI.tritiumUpload) {
      // Electron 环境：使用 IPC
      return await window.electronAPI.tritiumUpload(requestData);
    } else {
      // Web 环境：使用 OCR 服务的代理 API
      console.log('🌐 [Web] 使用代理 API 请求氚云...');
      try {
        const proxyUrl = '/api/proxy/h3yun';
        const response = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ 代理请求失败:', errorText);
          return { success: false, error: `代理请求失败 (${response.status}): ${errorText}` };
        }
        
        const result = await response.json();
        console.log('📨 代理响应:', result);
        return result;
      } catch (error) {
        console.error('❌ Web 代理请求异常:', error);
        return { success: false, error: `网络请求失败: ${error.message}` };
      }
    }
  }

  /**
   * 查询当天该用户的记录
   */
  async queryExistingRecord(userValue, dateValue) {
    try {
      const filter = {
        "FromRowNum": 0,
        "RequireCount": true,
        "ReturnItems": [],
        "SortByCollection": [],
        "ToRowNum": 500,
        "Matcher": {
          "Type": "And",
          "Matchers": [
            {
              "Type": "Item",
              "Name": "F0000020",
              "Operator": 2,
              "Value": dateValue
            }
          ]
        }
      };

      const result = await this.tritiumRequest({
        url: 'https://www.h3yun.com/OpenApi/Invoke',
        body: {
          ActionName: 'LoadBizObjects',
          SchemaCode: this.formCode,
          Filter: JSON.stringify(filter),
          RequireCount: false
        }
      });

      if (result.success && result.data && result.data.ReturnData && result.data.ReturnData.BizObjectArray) {
        const allRecords = result.data.ReturnData.BizObjectArray;
        console.log(`🔍 拉取到当天记录 ${allRecords.length} 条，正在筛选用户: ${userValue}...`);

        const targetRecords = allRecords.filter(record => {
          const recordUser37 = record.F0000037;
          const recordUser19 = record.F0000019;
          const recordUser19ObjectId = record.F0000019Object?.ObjectId;

          let match = false;
          if (recordUser37 === userValue) match = true;
          if (recordUser19 === userValue) match = true;
          if (recordUser19ObjectId === userValue) match = true;
          if (typeof recordUser19 === 'string' && recordUser19.includes(userValue)) match = true;

          return match;
        });

        if (targetRecords.length > 0) {
          console.log(`✅ 找到匹配记录:`, targetRecords[0]);
          return targetRecords[0];
        }
      }

      return null;
    } catch (error) {
      console.warn('⚠️ 查询现有记录失败:', error);
      return null;
    }
  }

  /**
   * 上传统计数据到氚云表单（支持追加）
   * @param {Object} data - 统计数据
   * @returns {Promise}
   */
  async uploadStats(data) {
    try {
      const formData = this.formatFormData(data);
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      // 获取人员ID用于查询
      let submitUserName = data.userName || '';
      if (this.USER_ID_MAP[submitUserName]) {
        submitUserName = this.USER_ID_MAP[submitUserName];
      }

      console.log('📤 准备上传到氚云:', formData);
      console.log('🔍 查询当天是否已有记录...');

      // 查询当天是否已有该用户的记录
      const existingRecord = await this.queryExistingRecord(submitUserName, date);

      if (existingRecord) {
        // 追加模式：更新现有记录
        console.log('📝 发现当天已有记录，将追加子表数据...');
        return await this.updateExistingRecord(existingRecord, formData);
      } else {
        // 创建模式：创建新记录
        console.log('➕ 当天无记录，创建新记录...');
        return await this.createNewRecord(formData);
      }
    } catch (error) {
      console.error('❌ 氚云上传错误:', error);
      throw error;
    }
  }

  /**
   * 创建新记录
   */
  async createNewRecord(formData) {
    const bizObjectString = JSON.stringify(formData);
    const requestBody = {
      ActionName: 'CreateBizObjects',
      SchemaCode: this.formCode,
      BizObjectArray: [bizObjectString],
      IsSubmit: true
    };

    console.log('📦 创建新记录请求:', requestBody);

    const result = await this.tritiumRequest({
      url: 'https://www.h3yun.com/OpenApi/Invoke',
      body: requestBody
    });

    if (result.success) {
      console.log('✅ 创建记录成功！');
      return { ...result, actionType: '创建' };
    } else {
      throw new Error(`创建失败: ${result.error || '未知错误'}`);
    }
  }

  /**
   * 更新现有记录（追加子表）
   */
  async updateExistingRecord(existingRecord, formData) {
    const bizObjectId = existingRecord.ObjectId || existingRecord.BizObjectId;
    console.log('📝 准备更新记录，BizObjectId:', bizObjectId);

    // 获取现有子表数据
    let currentSubtableData = existingRecord[this.subtableCode] || [];
    if (!Array.isArray(currentSubtableData)) {
      currentSubtableData = [];
    }

    // 清洗现有数据，只保留必要的业务字段
    const cleanSubtableData = currentSubtableData.map(item => ({
      F0000025: item.F0000025,
      F0000030: item.F0000030,
      F0000026: item.F0000026,
      F0000036: item.F0000036,
      F0000035: item.F0000035,
      F0000039: item.F0000039,
      F0000040: item.F0000040,
      F0000041: item.F0000041,
      F0000042: item.F0000042,
      F0000043: item.F0000043
    }));

    // 获取新的子表数据
    const newSubtableItem = formData[this.subtableCode]?.[0] || {};

    // 追加新数据
    const updatedSubtableData = [...cleanSubtableData, newSubtableItem];

    // 构造更新对象
    const updateBizObject = {
      [this.subtableCode]: updatedSubtableData
    };

    console.log('📤 更新子表数据:', updateBizObject);

    const result = await this.tritiumRequest({
      url: 'https://www.h3yun.com/OpenApi/Invoke',
      body: {
        ActionName: 'UpdateBizObject',
        SchemaCode: this.formCode,
        BizObjectId: bizObjectId,
        BizObject: JSON.stringify(updateBizObject),
        IsSubmit: true
      }
    });

    if (result.success) {
      console.log('✅ 追加记录成功！');
      return { ...result, actionType: '追加' };
    } else {
      throw new Error(`追加失败: ${result.error || '未知错误'}`);
    }
  }

  /**
   * 格式化表单数据
   */
  formatFormData(data) {
    console.log('🔍 formatFormData 接收到的数据:', data);

    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${day}`;

    // 处理姓名：如果有映射则转换为人员ID
    let submitUserName = data.userName || '';
    if (this.USER_ID_MAP[submitUserName]) {
      submitUserName = this.USER_ID_MAP[submitUserName];
      console.log(`👤 已将姓名 "${data.userName}" 转换为人员ID: ${submitUserName}`);
    }

    return {
      // 主表字段
      F0000037: data.userName || '',               // 姓名文本
      F0000019: submitUserName,                    // 人员单选（人员ID）
      F0000029: data.personnelType || '数据组成员',
      F0000020: date,

      // 子表数据
      [this.subtableCode]: [
        {
          F0000025: data.projectName || '',
          F0000030: data.processedPages || 0,
          F0000026: data.workHours || 0,
          F0000036: data.weldCount || 0,
          F0000035: '焊口识别与编号',
          F0000039: data.batchAdded || 0,
          F0000040: data.manuallyAdded || 0,
          F0000041: data.modified || 0,
          F0000042: data.detectionAccuracy || 0,
          F0000043: data.numberingAccuracy || 0,
          deletedCount: data.deleted || 0,
          YearMonth: yearMonth,
          Day: day
        }
      ]
    };
  }

  /**
   * 设置API配置
   */
  setConfig(config) {
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.appCode) this.appCode = config.appCode;
    if (config.formCode) this.formCode = config.formCode;
    if (config.engineCode) this.engineCode = config.engineCode;
  }
}

export const h3yunService = new H3yunService();
